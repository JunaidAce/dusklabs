import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { buildRfc4180Csv, escapeCsvCell } from '../src/utils/csv.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.5 — Analytics Accuracy, RBAC Scoping & CSV Formula Injection Protection', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0021',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00021',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(
    ctx: Awaited<ReturnType<typeof buildApp>>,
    tag: string,
    displayName: string,
    roleName?: string,
  ) {
    const username = `an_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AnalyticsStrongPass!123';
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName, email, password },
    });
    const userId = reg.json().user.id as string;
    cleanupUsers.push(userId);
    if (roleName) {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
      await prisma.userRole.create({ data: { userId, roleId: role.id } });
    }
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });
    return { userId, username, cookie: cookieOf(login), csrf: login.json().csrfToken as string };
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (cleanupChallenges.length) await prisma.challenge.deleteMany({ where: { id: { in: cleanupChallenges } } });
    if (cleanupComps.length) await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('neutralizes CSV formula injection payloads and quotes RFC-4180 fields', () => {
    expect(escapeCsvCell('=cmd|/C calc!A0')).toBe('"\'=cmd|/C calc!A0"');
    expect(escapeCsvCell(' +1+1')).toBe('"\' +1+1"');
    expect(escapeCsvCell('-2+3')).toBe('"\'-2+3"');
    expect(escapeCsvCell('@SUM(A1:A2)')).toBe('"\'@SUM(A1:A2)"');
    expect(escapeCsvCell('Hello, "World"')).toBe('"Hello, ""World"""');

    const csv = buildRfc4180Csv(['Name', 'Score'], [['=HYPERLINK("http://evil")', 100]]);
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"")"');
  });

  it('computes competition/platform analytics, enforces organizer scoping, and logs CSV exports', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const org1 = await createUser(ctx, 'org1', 'Org One', 'COMPETITION_ORGANIZER');
      const org2 = await createUser(ctx, 'org2', 'Org Two', 'COMPETITION_ORGANIZER');
      const mod = await createUser(ctx, 'mod', 'Moderator', 'MODERATOR');
      // Malicious displayName testing CSV formula neutralization end-to-end
      const player = await createUser(ctx, 'ply', '=CMD("calc")');
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const comp = await prisma.competition.create({
        data: {
          slug: `an-comp-${suffix}`,
          title: 'Analytics Cup',
          description: 'Testing analytics & CSV',
          rules: 'Standard rules',
          status: 'LIVE',
          isVisible: true,
          participationMode: 'INDIVIDUAL',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: org1.userId,
        },
      });
      cleanupComps.push(comp.id);
      await prisma.competitionRegistration.create({
        data: { competitionId: comp.id, userId: player.userId },
      });

      const secretFlag = 'DUSK{analytics_secret_flag}';
      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: {
          slug: `an-chal-${suffix}`,
          title: 'Analytics Target',
          description: 'Solve once after one miss.',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
          isVisible: true,
          points: 200,
          initialPoints: 200,
          competitionId: comp.id,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: secretFlag },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // 1 wrong + 1 correct submission -> 50% solve rate
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'DUSK{miss}' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: secretFlag },
      });

      // Participant, Moderator, and unrelated Organizer (org2) denied (403)
      for (const deniedActor of [player, mod, org2]) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/admin/analytics/competitions/${comp.id}`,
          headers: { cookie: deniedActor.cookie },
        });
        expect(res.statusCode).toBe(403);
      }

      // Owning Organizer (org1) receives accurate metrics
      const anRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/competitions/${comp.id}`,
        headers: { cookie: org1.cookie },
      });
      expect(anRes.statusCode).toBe(200);
      const body = anRes.json();
      expect(body.summary.confirmedParticipants).toBe(1);
      expect(body.summary.totalSubmissions).toBe(2);
      expect(body.summary.totalSolves).toBe(1);
      expect(body.challengeStats[0].solveRatePercent).toBe(50);
      expect(body.challengeStats[0].firstBlood.username).toBe(player.username);

      // Export Standings CSV -> verifies headers, formula neutralization, and zero secret leaks
      const csvRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/competitions/${comp.id}/export/standings.csv`,
        headers: { cookie: org1.cookie },
      });
      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      expect(csvRes.headers['x-content-type-options']).toBe('nosniff');
      expect(csvRes.headers['content-disposition']).toContain('attachment; filename="');
      expect(csvRes.body).toContain('"\'=CMD(""calc"")"');
      expect(csvRes.body).not.toContain(secretFlag);

      // Submissions CSV never leaks secrets/emails
      const subCsvRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/competitions/${comp.id}/export/submissions.csv`,
        headers: { cookie: org1.cookie },
      });
      expect(subCsvRes.statusCode).toBe(200);
      expect(subCsvRes.body).not.toContain(secretFlag);
      expect(subCsvRes.body).not.toContain('@dusklabs.local');

      // Audit log recorded CSV exports
      const auditCount = await prisma.auditLog.count({
        where: { action: 'ANALYTICS_CSV_EXPORTED', actorId: org1.userId, entityId: comp.id },
      });
      expect(auditCount).toBe(2);
    } finally {
      await ctx.app.close();
    }
  });
});
