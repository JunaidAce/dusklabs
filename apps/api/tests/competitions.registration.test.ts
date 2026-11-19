import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.3 — Competition Registration, Eligibility, Cancellation & Concurrency', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0012',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00012',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupTeams: string[] = [];
  const cleanupComps: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `rg_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'RegStrongPassword!123';
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
    if (cleanupComps.length) await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    if (cleanupTeams.length) await prisma.team.deleteMany({ where: { id: { in: cleanupTeams } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('handles individual registration, window checks, concurrency, and cancellation cutoff', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const org = await createUser(ctx, 'indorg', 'COMPETITION_ORGANIZER');
      const p1 = await createUser(ctx, 'ind1');

      const now = Date.now();
      const comp = await prisma.competition.create({
        data: {
          slug: `rg-ind-${suffix}`,
          title: 'Individual Reg Cup',
          description: 'Individual mode testing',
          rules: 'Standard',
          status: 'SCHEDULED',
          isVisible: true,
          participationMode: 'INDIVIDUAL',
          allowRegistrationCancel: true,
          registrationOpenAt: new Date(now - 60_000),
          registrationCloseAt: new Date(now + 120_000),
          cancellationCutoffAt: new Date(now + 60_000),
          startsAt: new Date(now + 180_000),
          endsAt: new Date(now + 360_000),
          createdById: org.userId,
        },
      });
      cleanupComps.push(comp.id);

      const earlyReg = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/individual`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      expect(earlyReg.statusCode).toBe(403);

      await prisma.competition.update({
        where: { id: comp.id },
        data: { status: 'REGISTRATION_OPEN' },
      });

      const burst = await Promise.all(
        Array.from({ length: 4 }, () =>
          ctx.app.inject({
            method: 'POST',
            url: `/api/v1/competitions/${comp.id}/register/individual`,
            headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
          }),
        ),
      );
      expect(burst.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(burst.filter((r) => r.statusCode === 409)).toHaveLength(3);

      const cancelOk = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/cancel`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      expect(cancelOk.statusCode).toBe(200);

      const reReg = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/individual`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      expect(reReg.statusCode).toBe(201);

      await prisma.competition.update({
        where: { id: comp.id },
        data: { cancellationCutoffAt: new Date(Date.now() - 10_000) },
      });
      const lateCancel = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/cancel`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      expect(lateCancel.statusCode).toBe(403);
      expect(lateCancel.json().error.code).toBe('CANCELLATION_NOT_ALLOWED');
    } finally {
      await ctx.app.close();
    }
  });

  it('enforces team mode, min/max team size, captain-only registration/cancellation, and multi-team conflict protection', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const org = await createUser(ctx, 'torg', 'COMPETITION_ORGANIZER');
      const cap1 = await createUser(ctx, 'cap1');
      const mem1 = await createUser(ctx, 'mem1');
      const cap2 = await createUser(ctx, 'cap2');

      const t1Res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: cap1.cookie, 'x-csrf-token': cap1.csrf },
        payload: { name: `RegAlpha_${suffix}` },
      });
      const team1 = t1Res.json().team;
      cleanupTeams.push(team1.id);

      const t2Res = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: cap2.cookie, 'x-csrf-token': cap2.csrf },
        payload: { name: `RegBeta_${suffix}` },
      });
      const team2 = t2Res.json().team;
      cleanupTeams.push(team2.id);

      const now = Date.now();
      const comp = await prisma.competition.create({
        data: {
          slug: `rg-team-${suffix}`,
          title: 'Team Reg Cup',
          description: 'Team mode min=2 max=3',
          rules: 'Standard',
          status: 'REGISTRATION_OPEN',
          isVisible: true,
          participationMode: 'TEAM',
          minTeamSize: 2,
          maxTeamSize: 3,
          registrationOpenAt: new Date(now - 60_000),
          registrationCloseAt: new Date(now + 120_000),
          startsAt: new Date(now + 180_000),
          endsAt: new Date(now + 360_000),
          createdById: org.userId,
        },
      });
      cleanupComps.push(comp.id);

      const wrongMode = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/individual`,
        headers: { cookie: cap1.cookie, 'x-csrf-token': cap1.csrf },
      });
      expect(wrongMode.statusCode).toBe(400);

      const tooSmall = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/team`,
        headers: { cookie: cap1.cookie, 'x-csrf-token': cap1.csrf },
        payload: { teamId: team1.id },
      });
      expect(tooSmall.statusCode).toBe(400);
      expect(tooSmall.json().error.code).toBe('TEAM_SIZE_OUT_OF_BOUNDS');

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams/join-by-code',
        headers: { cookie: mem1.cookie, 'x-csrf-token': mem1.csrf },
        payload: { inviteCode: team1.inviteCode },
      });

      // IDOR: non-captain cannot register team
      const nonCapReg = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/team`,
        headers: { cookie: mem1.cookie, 'x-csrf-token': mem1.csrf },
        payload: { teamId: team1.id },
      });
      expect(nonCapReg.statusCode).toBe(403);

      const teamOk = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/team`,
        headers: { cookie: cap1.cookie, 'x-csrf-token': cap1.csrf },
        payload: { teamId: team1.id },
      });
      expect(teamOk.statusCode).toBe(201);

      // Multi-team conflict blocked
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams/join-by-code',
        headers: { cookie: mem1.cookie, 'x-csrf-token': mem1.csrf },
        payload: { inviteCode: team2.inviteCode },
      });
      const multiTeam = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/team`,
        headers: { cookie: cap2.cookie, 'x-csrf-token': cap2.csrf },
        payload: { teamId: team2.id },
      });
      expect(multiTeam.statusCode).toBe(409);

      // Non-captain cannot cancel team registration
      const nonCapCancel = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/cancel`,
        headers: { cookie: mem1.cookie, 'x-csrf-token': mem1.csrf },
      });
      expect(nonCapCancel.statusCode).toBe(403);

      const capCancel = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/cancel`,
        headers: { cookie: cap1.cookie, 'x-csrf-token': cap1.csrf },
      });
      expect(capCancel.statusCode).toBe(200);

      const memStatus = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/${comp.id}/register/status`,
        headers: { cookie: mem1.cookie },
      });
      expect(memStatus.json().status).toBe('WITHDRAWN');
      expect(memStatus.json().history.map((h: any) => h.action)).toContain('CANCELLED');
    } finally {
      await ctx.app.close();
    }
  });
});
