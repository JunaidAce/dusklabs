import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.5 — Announcements Authorization, Notifications Persistence & Deduplication', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0014',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00014',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `nt_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'NotifyStrongPassword!123';
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
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('enforces announcement RBAC/IDOR and persists deduplicated registration, lifecycle, and announcement notifications', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const org1 = await createUser(ctx, 'org1', 'COMPETITION_ORGANIZER');
      const org2 = await createUser(ctx, 'org2', 'COMPETITION_ORGANIZER');
      const p1 = await createUser(ctx, 'p1');
      const p2 = await createUser(ctx, 'p2');

      const now = Date.now();
      const comp = await prisma.competition.create({
        data: {
          slug: `nt-comp-${suffix}`,
          title: 'Notification Cup',
          description: 'Testing notifications',
          rules: 'Standard rules',
          status: 'REGISTRATION_OPEN',
          isVisible: true,
          participationMode: 'INDIVIDUAL',
          registrationOpenAt: new Date(now - 60_000),
          registrationCloseAt: new Date(now + 120_000),
          startsAt: new Date(now - 5_000),
          endsAt: new Date(now + 300_000),
          createdById: org1.userId,
        },
      });
      cleanupComps.push(comp.id);

      // Participant cannot publish announcement (403)
      const pAnn = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/announcements`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
        payload: { title: 'Fake Notice', body: 'Unauthorized announcement' },
      });
      expect(pAnn.statusCode).toBe(403);

      // IDOR: org2 cannot publish to org1's competition (403)
      const org2Ann = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/announcements`,
        headers: { cookie: org2.cookie, 'x-csrf-token': org2.csrf },
        payload: { title: 'Hijack Notice', body: 'Unauthorized organizer' },
      });
      expect(org2Ann.statusCode).toBe(403);

      // Organizer cannot publish global platform announcement (403)
      const orgGlobal = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/announcements',
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { title: 'Global', body: 'Not allowed for organizer' },
      });
      expect(orgGlobal.statusCode).toBe(403);

      // p1 registers -> receives COMP_REG notification
      const regRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/register/individual`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      expect(regRes.statusCode).toBe(201);

      // org1 publishes announcement -> p1 receives ANNOUNCEMENT notification (unregistered p2 does not)
      const annRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/announcements`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { title: 'Challenge Hint Update', body: 'Check updated attachment hash.', isPinned: true },
      });
      expect(annRes.statusCode).toBe(201);
      const annId = annRes.json().announcement.id as string;

      // Transition UPCOMING -> LIVE -> PAUSED -> LIVE -> COMPLETED
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { targetStatus: 'UPCOMING' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { targetStatus: 'LIVE' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { targetStatus: 'PAUSED' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { targetStatus: 'LIVE' },
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${comp.id}/transition`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { targetStatus: 'COMPLETED' },
      });

      // p1 should have exactly 5 deduplicated notifications: COMP_REG, ANNOUNCEMENT,
      // COMP_LIVE (once!), COMP_END, plus the ACHIEVEMENT notification emitted by the
      // Phase 4.6 Competition Participant award on the COMPLETED transition.
      const inbox = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: p1.cookie },
      });
      expect(inbox.statusCode).toBe(200);
      expect(inbox.json().unreadCount).toBe(5);
      const types = inbox.json().notifications.map((n: any) => n.type);
      expect(types.filter((t: string) => t === 'COMP_LIVE')).toHaveLength(1);
      expect(types).toContain('COMP_REG');
      expect(types).toContain('ANNOUNCEMENT');
      expect(types).toContain('COMP_END');
      expect(types).toContain('ACHIEVEMENT');

      // IDOR: p2 cannot mark p1's notification read
      const firstNotifId = inbox.json().notifications[0].id as string;
      const idorRead = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${firstNotifId}/read`,
        headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
      });
      expect(idorRead.statusCode).toBe(403);

      // p1 marks one read, then marks all read
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/notifications/${firstNotifId}/read`,
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      const unreadOnly = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications?unreadOnly=true',
        headers: { cookie: p1.cookie },
      });
      // 5 unread minus the one just marked read (ACHIEVEMENT award adds a 5th,
      // see note above the first inbox assertion)
      expect(unreadOnly.json().unreadCount).toBe(4);

      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/notifications/read-all',
        headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
      });
      const afterAll = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/notifications',
        headers: { cookie: p1.cookie },
      });
      expect(afterAll.json().unreadCount).toBe(0);

      // Clean up announcement test edit/delete
      const patchAnn = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/announcements/${annId}`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { title: 'Updated Hint Notice' },
      });
      expect(patchAnn.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });
});
