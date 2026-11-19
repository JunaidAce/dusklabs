import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.6 — Achievements, Milestones, Team Champion, Snapshots, Privacy & Notifications', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0015',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00015',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];
  const cleanupAchievements: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `ach_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AchieveStrongPassword!123';
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
    // Achievement definitions are Restrict-guarded by UserAchievement; delete only after users (cascade removes awards)
    if (cleanupAchievements.length) await prisma.achievement.deleteMany({ where: { id: { in: cleanupAchievements } } });
    await prisma.$disconnect();
  });

  it('awards First Blood, First Solve, Category/Solve milestones, blocks failed/duplicate awards, and preserves snapshots', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const p1 = await createUser(ctx, 'p1');
      const p2 = await createUser(ctx, 'p2');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      // Unauthorized achievement definition creation blocked (403)
      const unauthCreate = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/achievements',
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: {
          code: `CUSTOM_${suffix.toUpperCase()}`,
          name: 'Hacker',
          description: 'Unauthorized',
          ruleType: 'TOTAL_SOLVES',
          threshold: 1,
        },
      });
      expect(unauthCreate.statusCode).toBe(403);

      // Authorized achievement definition creation succeeds (achievement:manage via PLATFORM_ADMIN)
      const authCreate = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/achievements',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          code: `CUSTOM_${suffix.toUpperCase()}`,
          name: 'Hacker',
          description: 'Authorized by admin',
          ruleType: 'TOTAL_SOLVES',
          threshold: 1,
        },
      });
      expect(authCreate.statusCode).toBe(201);
      cleanupAchievements.push(authCreate.json().achievement.id as string);

      // Create 5 published Web challenges
      const chalIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/challenges',
          headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
          payload: {
            slug: `ach-web-${i}-${suffix}`,
            title: `Web Milestone ${i}`,
            description: 'Solve to earn milestone.',
            difficulty: 'EASY',
            status: 'PUBLISHED',
            isVisible: true,
            points: 100,
            initialPoints: 100,
            categoryIds: [webCat.id],
            flagConfig: { flagType: 'STATIC_EXACT', flagValue: `DUSK{ach_${i}}` },
          },
        });
        chalIds.push(res.json().challenge.id as string);
      }
      cleanupChallenges.push(...chalIds);

      // Wrong submission must NOT award any achievement
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalIds[0]}/submit`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { flag: 'DUSK{wrong}' },
      });
      const afterWrong = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/achievements/me',
        headers: { cookie: p1.cookie },
      });
      expect(afterWrong.json().history).toHaveLength(0);

      // Concurrent solve submissions on challenge 1 (only 1 First Solve & 1 First Blood)
      await Promise.all(
        Array.from({ length: 3 }, () =>
          ctx.app.inject({
            method: 'POST',
            url: `/api/v1/challenges/${chalIds[0]}/submit`,
            headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
            payload: { flag: 'DUSK{ach_1}' },
          }),
        ),
      );

      // Solve remaining 4 Web challenges -> unlocks WEB_SPECIALIST (3) and FIVE_SOLVES (5)
      for (let i = 1; i < 5; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalIds[i]}/submit`,
          headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
          payload: { flag: `DUSK{ach_${i + 1}}` },
        });
      }

      const meRes = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/achievements/me',
        headers: { cookie: p1.cookie },
      });
      const earnedCodes = meRes.json().history.map((h: any) => h.code);
      expect(earnedCodes).toContain('FIRST_BLOOD');
      expect(earnedCodes).toContain('FIRST_SOLVE');
      expect(earnedCodes).toContain('WEB_SPECIALIST');
      expect(earnedCodes).toContain('FIVE_SOLVES');
      // Zero duplicate FIRST_BLOOD or FIRST_SOLVE rows
      expect(earnedCodes.filter((c: string) => c === 'FIRST_BLOOD')).toHaveLength(1);
      expect(earnedCodes.filter((c: string) => c === 'FIRST_SOLVE')).toHaveLength(1);

      // Notifications created for unlocked achievements
      const notifs = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: p1.cookie },
      });
      expect(notifs.json().notifications.some((n: any) => n.type === 'ACHIEVEMENT')).toBe(true);

      // Historical snapshot preservation when admin edits achievement name
      const firstSolveDef = await prisma.achievement.findUniqueOrThrow({ where: { code: 'FIRST_SOLVE' } });
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/achievements/${firstSolveDef.id}`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: { name: 'First Solve (Renamed)' },
      });
      const afterRename = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/achievements/me',
        headers: { cookie: p1.cookie },
      });
      const fsAward = afterRename.json().history.find((h: any) => h.code === 'FIRST_SOLVE');
      expect(fsAward.name).toBe('First Solve'); // Snapshot preserved!
      // Restore original name
      await prisma.achievement.update({ where: { id: firstSolveDef.id }, data: { name: 'First Solve' } });

      // Profile privacy toggle hides achievements from p2, but owner still sees them
      await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me/privacy',
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { showAchievementsOnProfile: false },
      });
      const hiddenView = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/users/${p1.username}/achievements`,
        headers: { cookie: p2.cookie },
      });
      expect(hiddenView.json().achievementsHidden).toBe(true);
      expect(hiddenView.json().achievements).toHaveLength(0);
    } finally {
      await ctx.app.close();
    }
  });

  it('awards Competition Participant and Competition Champion to all winning team members upon COMPLETED transition', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const org = await createUser(ctx, 'corg', 'COMPETITION_ORGANIZER');
      const cap = await createUser(ctx, 'cap');
      const mate = await createUser(ctx, 'mate');
      const cryptoCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'cryptography' } });

      const tRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
        payload: { name: `ChampTeam_${suffix}` },
      });
      const team = tRes.json().team;
      cleanupTeams.push(team.id);

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams/join-by-code',
        headers: { cookie: mate.cookie, 'x-csrf-token': mate.csrf },
        payload: { inviteCode: team.inviteCode },
      });

      const comp = await prisma.competition.create({
        data: {
          slug: `ach-comp-${suffix}`,
          title: 'Champion Team Cup',
          description: 'Team champion award verification',
          rules: 'Standard rules',
          status: 'LIVE',
          isVisible: true,
          participationMode: 'TEAM',
          minTeamSize: 1,
          maxTeamSize: 4,
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: org.userId,
        },
      });
      cleanupComps.push(comp.id);

      await prisma.competitionTeam.create({ data: { competitionId: comp.id, teamId: team.id } });
      await prisma.competitionRegistration.createMany({
        data: [
          { competitionId: comp.id, userId: cap.userId, teamId: team.id },
          { competitionId: comp.id, userId: mate.userId, teamId: team.id },
        ],
      });

      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: {
          slug: `ach-team-chal-${suffix}`,
          title: 'Final Crypto Target',
          description: 'Win the cup.',
          difficulty: 'MEDIUM',
          status: 'PUBLISHED',
          isVisible: true,
          points: 300,
          initialPoints: 300,
          competitionId: comp.id,
          categoryIds: [cryptoCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{team_champ}' },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // Cap solves -> Champion NOT yet awarded while LIVE
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: cap.cookie, 'x-csrf-token': cap.csrf },
        payload: { flag: 'DUSK{team_champ}' },
      });
      const midChamp = await prisma.userAchievement.count({
        where: { competitionId: comp.id, achievement: { code: 'COMPETITION_CHAMPION' } },
      });
      expect(midChamp).toBe(0);

      // Finalize competition -> BOTH cap and mate earn COMPETITION_PARTICIPANT & COMPETITION_CHAMPION
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'COMPLETED' },
      });

      const mateAch = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/achievements/me',
        headers: { cookie: mate.cookie },
      });
      const mateCodes = mateAch.json().history.map((h: any) => h.code);
      expect(mateCodes).toContain('COMPETITION_PARTICIPANT');
      expect(mateCodes).toContain('COMPETITION_CHAMPION');
    } finally {
      await ctx.app.close();
    }
  });
});
