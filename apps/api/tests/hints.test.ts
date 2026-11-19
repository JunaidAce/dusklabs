import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.5 — Hint Management, Secrecy, Ordering, Team Unlocks & Atomic Penalties', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0007',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00007',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `hn_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'HintStrongPassword!123';
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

  it('enforces RBAC, secrecy, ordering, non-negative score cap, and concurrent single-user unlock protection', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const author = await createUser(ctx, 'auth', 'CHALLENGE_AUTHOR');
      const player = await createUser(ctx, 'ply');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          slug: `hn-chal-${suffix}`,
          title: 'Multi-Hint Challenge',
          description: '100 point challenge with ordered hints.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{hint_flag_1}' },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // Unauthorized hint creation blocked
      const deniedHint = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { title: 'Cheat', content: 'Secret', costPoints: 0 },
      });
      expect(deniedHint.statusCode).toBe(403);

      const h1Res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints`,
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: { title: 'Hint One', content: 'Check parameter id', costPoints: 25 },
      });
      const h2Res = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints`,
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          title: 'Hint Two',
          content: 'Use UNION SELECT',
          costPoints: 90,
          requiresPreviousHint: true,
        },
      });
      const h1Id = h1Res.json().hint.id as string;
      const h2Id = h2Res.json().hint.id as string;

      // Locked hints must not expose content
      const beforeView = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/challenges/hn-chal-${suffix}/hints`,
        headers: { cookie: player.cookie },
      });
      expect(beforeView.statusCode).toBe(200);
      expect(beforeView.json().effectivePointsCurrent).toBe(100);
      expect(JSON.stringify(beforeView.json())).not.toContain('Check parameter id');
      expect(JSON.stringify(beforeView.json())).not.toContain('UNION SELECT');

      // Prerequisite ordering enforced
      const outOfOrder = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints/${h2Id}/unlock`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
      });
      expect(outOfOrder.statusCode).toBe(400);
      expect(outOfOrder.json().error.code).toBe('PREVIOUS_HINT_REQUIRED');

      // Concurrent unlock requests charge -25 exactly once
      const burst = await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.app.inject({
            method: 'POST',
            url: `/api/v1/challenges/${chalId}/hints/${h1Id}/unlock`,
            headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
          }),
        ),
      );
      expect(burst.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(burst.filter((r) => r.statusCode === 409)).toHaveLength(3);

      // Penalty capped at remaining effective points (75) to prevent negative challenge score
      const unlock2 = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints/${h2Id}/unlock`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
      });
      expect(unlock2.statusCode).toBe(200);
      expect(unlock2.json().hint.costApplied).toBe(75);
      expect(unlock2.json().effectivePointsRemaining).toBe(0);

      // Solve challenge (+100) -> net ledger = 100 - 25 - 75 = 0
      const solveRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'DUSK{hint_flag_1}' },
      });
      expect(solveRes.statusCode).toBe(200);

      const ledgerSum = await prisma.scoreTransaction.aggregate({
        where: { userId: player.userId },
        _sum: { deltaPoints: true },
      });
      expect(ledgerSum._sum.deltaPoints).toBe(0);
    } finally {
      await ctx.app.close();
    }
  });

  it('enforces team-wide single penalty under concurrent teammate unlocks and competition gating', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const admin = await createUser(ctx, 'tadm', 'PLATFORM_ADMIN');
      const tm1 = await createUser(ctx, 'tm1');
      const tm2 = await createUser(ctx, 'tm2');
      const unreg = await createUser(ctx, 'unreg');
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'cryptography' } });

      const teamRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: tm1.cookie, 'x-csrf-token': tm1.csrf },
        payload: { name: `HintSquad_${suffix}` },
      });
      const team = teamRes.json().team;
      cleanupTeams.push(team.id);

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams/join-by-code',
        headers: { cookie: tm2.cookie, 'x-csrf-token': tm2.csrf },
        payload: { inviteCode: team.inviteCode },
      });

      const comp = await prisma.competition.create({
        data: {
          slug: `hn-comp-${suffix}`,
          title: 'Hint Comp',
          description: 'Team hint verification',
          rules: 'Standard',
          status: 'SCHEDULED',
          participationMode: 'TEAM',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(comp.id);
      await prisma.competitionTeam.create({ data: { competitionId: comp.id, teamId: team.id } });

      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `hn-team-chal-${suffix}`,
          title: 'Team Hint Challenge',
          description: 'Team-shared hint unlock.',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
          isVisible: true,
          points: 200,
          initialPoints: 200,
          competitionId: comp.id,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{team_hint_ok}' },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      const hRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: { title: 'Team Hint', content: 'Factor N using Fermat', costPoints: 40 },
      });
      const hintId = hRes.json().hint.id as string;

      // Blocked while competition is SCHEDULED
      const preLive = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints/${hintId}/unlock`,
        headers: { cookie: tm1.cookie, 'x-csrf-token': tm1.csrf },
      });
      expect(preLive.statusCode).toBe(403);

      await prisma.competition.update({ where: { id: comp.id }, data: { status: 'LIVE' } });

      // Unregistered participant blocked
      const unregTry = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/hints/${hintId}/unlock`,
        headers: { cookie: unreg.cookie, 'x-csrf-token': unreg.csrf },
      });
      expect(unregTry.statusCode).toBe(403);

      // Teammates race to unlock -> only ONE penalty applied
      const [u1, u2] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/hints/${hintId}/unlock`,
          headers: { cookie: tm1.cookie, 'x-csrf-token': tm1.csrf },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/hints/${hintId}/unlock`,
          headers: { cookie: tm2.cookie, 'x-csrf-token': tm2.csrf },
        }),
      ]);
      expect([u1.statusCode, u2.statusCode].sort()).toEqual([200, 409]);

      // Teammate tm2 sees unlocked hint content
      const tm2View = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/challenges/${chalId}/hints`,
        headers: { cookie: tm2.cookie },
      });
      expect(tm2View.json().hints[0].unlocked).toBe(true);
      expect(tm2View.json().hints[0].content).toBe('Factor N using Fermat');

      const teamPenaltySum = await prisma.scoreTransaction.aggregate({
        where: { teamId: team.id, competitionId: comp.id },
        _sum: { deltaPoints: true },
      });
      expect(teamPenaltySum._sum.deltaPoints).toBe(-40);
    } finally {
      await ctx.app.close();
    }
  });
});
