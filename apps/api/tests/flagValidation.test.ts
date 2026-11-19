import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { decryptSecret, deriveDynamicFlag } from '../src/utils/flagCrypto.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.4 — Flag Validation Engine, Concurrency & Security', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0006',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00006',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `fv_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'FlagValStrongPassword!123';
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
    if (cleanupTeams.length) await prisma.team.deleteMany({ where: { id: { in: cleanupTeams } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('validates static exact, case-insensitive, attempt limits, author lock, and concurrent duplicate prevention', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const author = await createUser(ctx, 'auth', 'CHALLENGE_AUTHOR');
      const p1 = await createUser(ctx, 'p1');
      const p2 = await createUser(ctx, 'p2');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      // 1. Static exact challenge with maxAttempts = 2
      const exactFlag = 'DUSK{Exact_Flag_Value_1}';
      const c1 = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          slug: `fv-exact-${suffix}`,
          title: 'Exact Flag Challenge',
          description: 'Submit exact flag.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          maxAttempts: 2,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: exactFlag },
        },
      });
      const c1Id = c1.json().challenge.id as string;
      cleanupChallenges.push(c1Id);

      // Author self-solve blocked
      const authorTry = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c1Id}/submit`,
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: { flag: exactFlag },
      });
      expect(authorTry.statusCode).toBe(403);

      // Wrong attempt 1 & 2 -> 3rd attempt blocked by maxAttempts
      const wrong1 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/fv-exact-${suffix}/submit`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { flag: 'DUSK{wrong1}' },
      });
      expect(wrong1.statusCode).toBe(200);
      expect(wrong1.json().correct).toBe(false);
      expect(wrong1.json().remainingAttempts).toBe(1);

      const wrong2 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c1Id}/submit`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { flag: 'DUSK{wrong2}' },
      });
      expect(wrong2.json().remainingAttempts).toBe(0);

      const blocked3 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c1Id}/submit`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { flag: exactFlag },
      });
      expect(blocked3.statusCode).toBe(429);
      expect(blocked3.json().error.code).toBe('ATTEMPT_LIMIT_EXCEEDED');

      // Concurrent duplicate submissions from p2: exactly ONE succeeds, rest return 409 ALREADY_SOLVED
      const burst = await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.app.inject({
            method: 'POST',
            url: `/api/v1/challenges/${c1Id}/submit`,
            headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
            payload: { flag: exactFlag },
          }),
        ),
      );
      const successes = burst.filter((r) => r.statusCode === 200 && r.json().correct === true);
      const conflicts = burst.filter((r) => r.statusCode === 409);
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(4);
      expect(successes[0]!.json().isFirstBlood).toBe(true);

      const p2ScoreSum = await prisma.scoreTransaction.aggregate({
        where: { userId: p2.userId },
        _sum: { deltaPoints: true },
      });
      expect(p2ScoreSum._sum.deltaPoints).toBe(100);

      // 2. Case-insensitive challenge
      const c2 = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          slug: `fv-ci-${suffix}`,
          title: 'Case Insensitive',
          description: 'Any casing accepted.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 120,
          initialPoints: 120,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_CASE_INSENSITIVE', flagValue: 'DUSK{MixedCaseFlag}' },
        },
      });
      const c2Id = c2.json().challenge.id as string;
      cleanupChallenges.push(c2Id);

      const ciSubmit = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c2Id}/submit`,
        headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
        payload: { flag: 'dusk{mixedcaseflag}' },
      });
      expect(ciSubmit.statusCode).toBe(200);
      expect(ciSubmit.json().correct).toBe(true);
      expect(JSON.stringify(ciSubmit.json())).not.toContain('MixedCaseFlag');
    } finally {
      await ctx.app.close();
    }
  });

  it('enforces competition LIVE window, dynamic team flags, and blocks concurrent teammate double-scoring', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const m1 = await createUser(ctx, 'tm1');
      const m2 = await createUser(ctx, 'tm2');
      const outsider = await createUser(ctx, 'out');
      const cryptoCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'cryptography' } });

      // Create team with m1 & m2
      const teamRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: m1.cookie, 'x-csrf-token': m1.csrf },
        payload: { name: `FVTeam_${suffix}` },
      });
      const team = teamRes.json().team;
      cleanupTeams.push(team.id);

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams/join-by-code',
        headers: { cookie: m2.cookie, 'x-csrf-token': m2.csrf },
        payload: { inviteCode: team.inviteCode },
      });

      // Create PAUSED competition first
      const comp = await prisma.competition.create({
        data: {
          slug: `fv-comp-${suffix}`,
          title: 'Team Flag Comp',
          description: 'Testing team dynamic flags & competition window',
          rules: 'Standard',
          status: 'PAUSED',
          participationMode: 'TEAM',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(comp.id);

      await prisma.competitionTeam.create({ data: { competitionId: comp.id, teamId: team.id } });

      const chalRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `fv-dyn-${suffix}`,
          title: 'Team Dynamic Challenge',
          description: 'Team-keyed HMAC flag.',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
          isVisible: true,
          points: 200,
          initialPoints: 200,
          competitionId: comp.id,
          categoryIds: [cryptoCat.id],
          flagConfig: {
            flagType: 'DYNAMIC_HMAC_PATTERN',
            flagValue: 'team-seed-xyz',
            dynamicPattern: 'DUSK{team_{{TOKEN}}}',
          },
        },
      });
      const chalId = chalRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      const stored = await prisma.flagConfiguration.findUniqueOrThrow({ where: { challengeId: chalId } });
      const seed = decryptSecret(stored.encryptedFlag!, env.FLAG_ENCRYPTION_KEY);
      const teamFlag = deriveDynamicFlag({
        seed,
        pattern: stored.dynamicPattern!,
        challengeId: chalId,
        participantKey: team.id,
      });

      // Rejected while competition is PAUSED
      const pausedTry = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: m1.cookie, 'x-csrf-token': m1.csrf },
        payload: { flag: teamFlag },
      });
      expect(pausedTry.statusCode).toBe(403);
      expect(pausedTry.json().error.code).toBe('COMPETITION_NOT_LIVE');

      // Set competition LIVE
      await prisma.competition.update({ where: { id: comp.id }, data: { status: 'LIVE' } });

      // Unregistered outsider rejected
      const outsiderTry = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: outsider.cookie, 'x-csrf-token': outsider.csrf },
        payload: { flag: teamFlag },
      });
      expect(outsiderTry.statusCode).toBe(403);

      // Simultaneous submission by teammate m1 and m2 -> only ONE solve & ONE score entry
      const [r1, r2] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/submit`,
          headers: { cookie: m1.cookie, 'x-csrf-token': m1.csrf },
          payload: { flag: teamFlag },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/submit`,
          headers: { cookie: m2.cookie, 'x-csrf-token': m2.csrf },
          payload: { flag: teamFlag },
        }),
      ]);
      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);

      const teamScore = await prisma.scoreTransaction.aggregate({
        where: { teamId: team.id, competitionId: comp.id },
        _sum: { deltaPoints: true },
      });
      expect(teamScore._sum.deltaPoints).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it('enforces per-user/challenge rate limiting on rapid flag submissions', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 2 });
    try {
      const admin = await createUser(ctx, 'rladm', 'PLATFORM_ADMIN');
      const player = await createUser(ctx, 'rlply');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `fv-rl-${suffix}`,
          title: 'Rate Limit Target',
          description: 'Testing rate limiter.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{rl_target}' },
        },
      });
      const cid = cRes.json().challenge.id as string;
      cleanupChallenges.push(cid);

      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${cid}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'wrong1' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${cid}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'wrong2' },
      });
      const third = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${cid}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'wrong3' },
      });
      expect(third.statusCode).toBe(429);
    } finally {
      await ctx.app.close();
    }
  });
});
