import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { computeDynamicPoints } from '../src/modules/scoring/scoring.service.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.6 — Scoring Engine (Static, Dynamic Decay, First Blood, Ledger, Adjustments)', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0008',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00008',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `sc_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'ScoringStrongPassword!123';
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

  it('computes deterministic quadratic dynamic decay bounds', () => {
    expect(computeDynamicPoints({ initialPoints: 500, minPoints: 100, decayRate: 10, solveCount: 1 })).toBe(500);
    expect(computeDynamicPoints({ initialPoints: 500, minPoints: 100, decayRate: 10, solveCount: 6 })).toBe(400);
    expect(computeDynamicPoints({ initialPoints: 500, minPoints: 100, decayRate: 10, solveCount: 11 })).toBe(100);
    expect(computeDynamicPoints({ initialPoints: 500, minPoints: 100, decayRate: 10, solveCount: 50 })).toBe(100);
  });

  it('awards single First Blood under concurrent race, applies retroactive dynamic decay, and records audited adjustments', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const u1 = await createUser(ctx, 'u1');
      const u2 = await createUser(ctx, 'u2');
      const u3 = await createUser(ctx, 'u3');
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'reverse-engineering' } });

      const comp = await prisma.competition.create({
        data: {
          slug: `sc-comp-${suffix}`,
          title: 'Dynamic Scoring Open',
          description: 'Testing dynamic decay & first blood',
          rules: 'Standard',
          status: 'LIVE',
          participationMode: 'INDIVIDUAL',
          scoringMode: 'DYNAMIC',
          dynamicScoringPolicy: 'RETROACTIVE',
          firstBloodEnabled: true,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(comp.id);

      for (const u of [u1, u2, u3]) {
        await prisma.competitionRegistration.create({
          data: { competitionId: comp.id, userId: u.userId },
        });
      }

      const flag = 'DUSK{dynamic_scoring_fb}';
      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `sc-dyn-${suffix}`,
          title: 'Dynamic Reverse Challenge',
          description: 'Decays from 500 to 100 over 2 decay steps.',
          difficulty: 'HARD',
          status: 'PUBLISHED',
          isVisible: true,
          scoringMode: 'DYNAMIC',
          points: 500,
          initialPoints: 500,
          minPoints: 100,
          decayRate: 2,
          firstBloodBonus: 50,
          competitionId: comp.id,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: flag },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // u1 and u2 race concurrently -> only ONE gets First Blood (+50)
      const [r1, r2] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/submit`,
          headers: { cookie: u1.cookie, 'x-csrf-token': u1.csrf },
          payload: { flag },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/submit`,
          headers: { cookie: u2.cookie, 'x-csrf-token': u2.csrf },
          payload: { flag },
        }),
      ]);
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);

      const fbWinners = [r1.json(), r2.json()].filter((r) => r.isFirstBlood === true);
      expect(fbWinners).toHaveLength(1);

      const fbTxCount = await prisma.scoreTransaction.count({
        where: { competitionId: comp.id, type: 'FIRST_BLOOD' },
      });
      expect(fbTxCount).toBe(1);

      // u3 solves -> solveCount=3 reaches minPoints=100; u1 & u2 decay retroactively
      const r3 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: u3.cookie, 'x-csrf-token': u3.csrf },
        payload: { flag },
      });
      expect(r3.statusCode).toBe(200);
      expect(r3.json().pointsAwarded).toBe(100);

      const standings = await ctx.scoringService.computeStandings({
        competitionId: comp.id,
        entityType: 'INDIVIDUAL',
      });
      expect(standings).toHaveLength(3);
      expect(standings[0]!.totalPoints).toBe(150);
      expect(standings[1]!.totalPoints).toBe(100);
      expect(standings[2]!.totalPoints).toBe(100);

      // Manual adjustment writes ScoreTransaction + AuditLog
      const adjRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/scores/adjust',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          userId: u3.userId,
          competitionId: comp.id,
          deltaPoints: 25,
          reason: 'Verified bug bounty report bonus',
        },
      });
      expect(adjRes.statusCode).toBe(200);

      const auditEntry = await prisma.auditLog.findFirst({
        where: { action: 'SCORE_MANUALLY_ADJUSTED', actorId: admin.userId },
      });
      expect(auditEntry).not.toBeNull();
    } finally {
      await ctx.app.close();
    }
  });
});
