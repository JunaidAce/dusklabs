import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 3 Step 3.7 — Live Leaderboards, Tie-Breaking, Category Stats & Secrecy', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0009',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00009',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `lb_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'LeaderboardStrongPass!123';
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: `User ${tag}`, email, password, country: 'US' },
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

  it('ranks global & competition leaderboards with deterministic tie-breaking, pagination, category stats, and secrecy', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const p1 = await createUser(ctx, 'p1');
      const p2 = await createUser(ctx, 'p2');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      // Create team for p1
      const t1Res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { name: `LBAlpha_${suffix}` },
      });
      const team1 = t1Res.json().team;
      cleanupTeams.push(team1.id);

      const t2Res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
        payload: { name: `LBBeta_${suffix}` },
      });
      const team2 = t2Res.json().team;
      cleanupTeams.push(team2.id);

      // Draft competition must not be publicly accessible on leaderboard
      const draftComp = await prisma.competition.create({
        data: {
          slug: `lb-draft-${suffix}`,
          title: 'Hidden Draft Comp',
          description: 'Draft',
          rules: 'Standard',
          status: 'DRAFT',
          startsAt: new Date(Date.now() + 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(draftComp.id);

      const draftLb = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/leaderboards/competitions/lb-draft-${suffix}`,
        headers: { cookie: p1.cookie },
      });
      expect(draftLb.statusCode).toBe(404);

      // LIVE team competition
      const comp = await prisma.competition.create({
        data: {
          slug: `lb-live-${suffix}`,
          title: 'Live LB Cup',
          description: 'Live',
          rules: 'Standard',
          status: 'LIVE',
          participationMode: 'TEAM',
          scoringMode: 'STATIC',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(comp.id);
      await prisma.competitionTeam.createMany({
        data: [
          { competitionId: comp.id, teamId: team1.id },
          { competitionId: comp.id, teamId: team2.id },
        ],
      });

      const pubChal = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `lb-web-${suffix}`,
          title: 'Public Web Target',
          description: 'Visible challenge.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          competitionId: comp.id,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{lb_pub}' },
        },
      });
      const pubId = pubChal.json().challenge.id as string;
      cleanupChallenges.push(pubId);

      // Create a hidden DRAFT challenge (must never appear in category stats or recent solves)
      const hiddenChal = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `lb-secret-${suffix}`,
          title: 'Secret Unpublished Challenge',
          description: 'Should stay hidden.',
          difficulty: 'HARD',
          status: 'DRAFT',
          isVisible: false,
          points: 300,
          initialPoints: 300,
          competitionId: comp.id,
          categoryIds: [webCat.id],
        },
      });
      cleanupChallenges.push(hiddenChal.json().challenge.id as string);

      // p1 solves first (earlier timestamp), p2 solves second -> tie on 100 pts, p1 wins tie-breaker
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${pubId}/submit`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { flag: 'DUSK{lb_pub}' },
      });
      await new Promise((r) => setTimeout(r, 20));
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${pubId}/submit`,
        headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
        payload: { flag: 'DUSK{lb_pub}' },
      });

      // Competition TEAM leaderboard with pagination limit=1 & currentUserEntry for p2
      const compTeamPg1 = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/leaderboards/competitions/lb-live-${suffix}?type=TEAM&page=1&limit=1`,
        headers: { cookie: p2.cookie },
      });
      expect(compTeamPg1.statusCode).toBe(200);
      const body = compTeamPg1.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].entityId).toBe(team1.id);
      expect(body.entries[0].firstBloodCount).toBe(1);
      expect(body.pagination.total).toBe(2);
      expect(body.pagination.totalPages).toBe(2);
      // p2 is rank 2 (off page 1) yet still returned cleanly in currentUserEntry
      expect(body.currentUserEntry.entityId).toBe(team2.id);
      expect(body.currentUserEntry.rank).toBe(2);

      // Category stats count only PUBLISHED challenges (1, not 2)
      const webStat = body.categoryStats.find((c: any) => c.slug === 'web-exploitation');
      expect(webStat.publishedChallengeCount).toBe(1);
      expect(webStat.totalSolves).toBe(2);

      // Recent solves never expose emails, flags, or unpublished challenge titles
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('Secret Unpublished Challenge');
      expect(serialized).not.toContain('DUSK{lb_pub}');
      expect(serialized).not.toContain('@dusklabs.local');

      // Global individual leaderboard matches
      const globalInd = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/leaderboards/global?type=INDIVIDUAL',
        headers: { cookie: p1.cookie },
      });
      expect(globalInd.statusCode).toBe(200);
      expect(globalInd.json().currentUserEntry.slugOrUsername).toBe(p1.username);
    } finally {
      await ctx.app.close();
    }
  });
});
