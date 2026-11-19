import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.1 — Admin Dashboard Overview RBAC & Real Telemetry', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0017',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00017',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(
    ctx: Awaited<ReturnType<typeof buildApp>>,
    tag: string,
    roleName?: string,
    accountStatus: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
  ) {
    const username = `ao_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AdminOvStrongPassword!123';
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: `User ${tag}`, email, password },
    });
    const userId = reg.json().user.id as string;
    cleanupUsers.push(userId);
    if (roleName) {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
      await prisma.userRole.create({ data: { userId, roleId: role.id } });
    }
    if (accountStatus !== 'ACTIVE') {
      await prisma.user.update({ where: { id: userId }, data: { accountStatus } });
    }
    const login =
      accountStatus === 'ACTIVE'
        ? await ctx.app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            payload: { identifier: username, password },
          })
        : null;
    return {
      userId,
      username,
      cookie: login ? cookieOf(login) : '',
      csrf: login ? (login.json().csrfToken as string) : '',
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    // Report rows hold Restrict FKs on reporter/resolver and must go before users.
    await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: cleanupUsers } }, { resolvedById: { in: cleanupUsers } }] },
    });
    if (cleanupChallenges.length) await prisma.challenge.deleteMany({ where: { id: { in: cleanupChallenges } } });
    if (cleanupComps.length) await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    if (cleanupTeams.length) await prisma.team.deleteMany({ where: { id: { in: cleanupTeams } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('denies unauthenticated and non-admin/non-moderator roles while returning accurate DB metrics to Platform Admin', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const organizer = await createUser(ctx, 'org', 'COMPETITION_ORGANIZER');
      const author = await createUser(ctx, 'auth', 'CHALLENGE_AUTHOR');
      const participant = await createUser(ctx, 'ply');
      await createUser(ctx, 'susp', undefined, 'SUSPENDED');

      // 1. Unauthenticated -> 401
      const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
      expect(anon.statusCode).toBe(401);

      // 2. Participant, Author, and Organizer -> 403
      for (const actor of [participant, author, organizer]) {
        const denied = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/overview',
          headers: { cookie: actor.cookie },
        });
        expect(denied.statusCode).toBe(403);
      }

      // 3. Create real team, competition, challenge, submissions, and report
      const teamRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: participant.cookie, 'x-csrf-token': participant.csrf },
        payload: { name: `AdminOvTeam_${suffix}` },
      });
      cleanupTeams.push(teamRes.json().team.id);

      const comp = await prisma.competition.create({
        data: {
          slug: `ao-comp-${suffix}`,
          title: 'Admin Overview Cup',
          description: 'Live comp',
          rules: 'Standard',
          status: 'LIVE',
          isVisible: true,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(comp.id);

      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });
      const chalRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          slug: `ao-chal-${suffix}`,
          title: 'Overview Target',
          description: 'Submit once wrong, once right.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{ao_ok}' },
        },
      });
      const chalId = chalRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // 1 failed + 1 valid submission
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: participant.cookie, 'x-csrf-token': participant.csrf },
        payload: { flag: 'DUSK{wrong}' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: participant.cookie, 'x-csrf-token': participant.csrf },
        payload: { flag: 'DUSK{ao_ok}' },
      });

      await prisma.report.create({
        data: {
          reporterId: participant.userId,
          challengeId: chalId,
          category: 'BUG',
          description: 'Sample moderation report for overview verification.',
          status: 'OPEN',
        },
      });

      // 4. Platform Admin retrieves live overview
      const okRes = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/overview',
        headers: { cookie: admin.cookie },
      });
      expect(okRes.statusCode).toBe(200);
      const body = okRes.json();

      expect(body.metrics.users.total).toBeGreaterThanOrEqual(5);
      expect(body.metrics.users.suspended).toBeGreaterThanOrEqual(1);
      expect(body.metrics.teams.total).toBeGreaterThanOrEqual(1);
      expect(body.metrics.competitions.live).toBeGreaterThanOrEqual(1);
      expect(body.metrics.challenges.published).toBeGreaterThanOrEqual(1);
      expect(body.metrics.submissions.valid).toBeGreaterThanOrEqual(1);
      expect(body.metrics.submissions.failed).toBeGreaterThanOrEqual(1);
      expect(body.metrics.moderation.openReports).toBeGreaterThanOrEqual(1);
      expect(body.recentAuditEvents.length).toBeGreaterThan(0);
      expect(body.recentActivity.solves.some((s: any) => s.challenge.slug === `ao-chal-${suffix}`)).toBe(true);

      // Secrecy check: zero password hashes or expected flag leaked
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('DUSK{ao_ok}');
    } finally {
      await ctx.app.close();
    }
  });
});
