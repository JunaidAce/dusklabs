import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.2 — Competition Lifecycle State Machine, Scheduler, Boundaries & Concurrency', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0011',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00011',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `lc_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'LifecycleStrongPassword!123';
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

  it('enforces full lifecycle transitions, time boundaries, pause/resume submission blocking, concurrency, and audit logs', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const org = await createUser(ctx, 'org', 'COMPETITION_ORGANIZER');
      const player = await createUser(ctx, 'ply');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      // Configure with explicit UTC-4 timezone offset (America/New_York)
      const t0 = Date.now();
      const regOpen = new Date(t0 + 60_000).toISOString();
      const regClose = new Date(t0 + 120_000).toISOString();
      const startsAt = new Date(t0 + 180_000).toISOString();
      const endsAt = new Date(t0 + 300_000).toISOString();

      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/competitions',
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: {
          slug: `lc-cup-${suffix}`,
          title: 'Lifecycle Verification Cup',
          description: 'Verifies all 8 competition lifecycle states.',
          rules: 'Standard rules.',
          timezone: 'America/New_York',
          participationMode: 'INDIVIDUAL',
          registrationOpenAt: regOpen,
          registrationCloseAt: regClose,
          startsAt,
          endsAt,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const compId = createRes.json().competition.id as string;
      cleanupComps.push(compId);

      // Attach published challenge & confirmed participant for submission tests
      const chalRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: {
          slug: `lc-chal-${suffix}`,
          title: 'Lifecycle Target',
          description: 'Flag submission gated by competition lifecycle.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          competitionId: compId,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{lc_ok}' },
        },
      });
      const chalId = chalRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);
      await prisma.competitionRegistration.create({ data: { competitionId: compId, userId: player.userId } });

      // Unauthorized participant cannot transition
      const unauthTrans = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { targetStatus: 'SCHEDULED' },
      });
      expect(unauthTrans.statusCode).toBe(403);

      // Invalid transition: DRAFT -> LIVE blocked
      const skipLive = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'LIVE' },
      });
      expect(skipLive.statusCode).toBe(400);

      // DRAFT -> SCHEDULED
      const toSched = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'SCHEDULED', reason: 'Schedule finalized' },
      });
      expect(toSched.statusCode).toBe(200);

      // Organizer cannot bypass registrationOpenAt manually
      const earlyReg = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'REGISTRATION_OPEN' },
      });
      expect(earlyReg.statusCode).toBe(400);
      expect(earlyReg.json().error.code).toBe('REGISTRATION_WINDOW_NOT_STARTED');

      // Scheduler advances SCHEDULED -> REGISTRATION_OPEN at regOpen
      await ctx.lifecycleScheduler.processScheduledTransitions(new Date(t0 + 65_000));
      // Scheduler advances REGISTRATION_OPEN -> UPCOMING at regClose
      await ctx.lifecycleScheduler.processScheduledTransitions(new Date(t0 + 125_000));
      let row = await prisma.competition.findUniqueOrThrow({ where: { id: compId } });
      expect(row.status).toBe('UPCOMING');

      // Organizer cannot bypass startsAt manually
      const earlyLive = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'LIVE' },
      });
      expect(earlyLive.statusCode).toBe(400);
      expect(earlyLive.json().error.code).toBe('COMPETITION_NOT_STARTED');

      // Adjust startsAt & endsAt to enclose current server clock so LIVE submission tests run cleanly
      await prisma.competition.update({
        where: { id: compId },
        data: {
          startsAt: new Date(Date.now() - 10_000),
          endsAt: new Date(Date.now() + 120_000),
        },
      });

      // Concurrent transition UPCOMING -> LIVE: exactly one succeeds, second gets 409/400
      const [tr1, tr2] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/competitions/${compId}/transition`,
          headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
          payload: { targetStatus: 'LIVE', reason: 'Go live' },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/competitions/${compId}/transition`,
          headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
          payload: { targetStatus: 'LIVE', reason: 'Duplicate click' },
        }),
      ]);
      expect([tr1.statusCode, tr2.statusCode].sort()[0]).toBe(200);
      expect([tr1.statusCode, tr2.statusCode].sort()[1]).toBeGreaterThanOrEqual(400);

      // Pause LIVE -> PAUSED: flag submission rejected while PAUSED
      const pauseRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'PAUSED', reason: 'Investigating issue' },
      });
      expect(pauseRes.statusCode).toBe(200);

      const pausedSubmit = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'DUSK{lc_ok}' },
      });
      expect(pausedSubmit.statusCode).toBe(403);
      expect(pausedSubmit.json().error.code).toBe('COMPETITION_NOT_LIVE');

      // Resume PAUSED -> LIVE: submission succeeds
      const resumeRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'LIVE', reason: 'Resumed' },
      });
      expect(resumeRes.statusCode).toBe(200);

      const liveSubmit = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: 'DUSK{lc_ok}' },
      });
      expect(liveSubmit.statusCode).toBe(200);

      // LIVE -> COMPLETED -> ARCHIVED (cannot edit archived)
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'COMPLETED' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/transition`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { targetStatus: 'ARCHIVED' },
      });

      const editArchived = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/competitions/${compId}`,
        headers: { cookie: org.cookie, 'x-csrf-token': org.csrf },
        payload: { title: 'Edited After Archive' },
      });
      expect(editArchived.statusCode).toBe(409);

      // Audit logs captured both SYSTEM_SCHEDULER and ORGANIZER transitions
      const logs = await prisma.auditLog.findMany({
        where: { entityType: 'Competition', entityId: compId, action: 'COMPETITION_LIFECYCLE_TRANSITION' },
      });
      expect(logs.length).toBeGreaterThanOrEqual(6);
      expect(logs.some((l) => l.actorId === null)).toBe(true);
      expect(logs.some((l) => l.actorId === org.userId)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });
});
