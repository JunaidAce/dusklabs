import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.2 — User, Role, Suspension, Ban & Session Security', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0018',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00018',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `au_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AdminUserStrongPass!123';
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
    return {
      userId,
      username,
      email,
      password,
      cookie: cookieOf(login),
      csrf: login.json().csrfToken as string,
    };
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await prisma.$disconnect();
  });

  it('enforces user search, role privilege-escalation protection, and last super admin guard', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const superAdmin = await createUser(ctx, 'sa', 'SUPER_ADMIN');
      const platAdmin = await createUser(ctx, 'pa', 'PLATFORM_ADMIN');
      const mod = await createUser(ctx, 'mod', 'MODERATOR');
      const target = await createUser(ctx, 'tgt');

      // Search & role filter
      const searchRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/users?search=${target.username}`,
        headers: { cookie: platAdmin.cookie },
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.json().users.some((u: any) => u.id === target.userId)).toBe(true);

      // Participant blocked (403)
      const pDenied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { cookie: target.cookie },
      });
      expect(pDenied.statusCode).toBe(403);

      // Moderator cannot assign roles (403)
      const modRoleDenied = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${target.userId}/roles`,
        headers: { cookie: mod.cookie, 'x-csrf-token': mod.csrf },
        payload: { roleName: 'CHALLENGE_AUTHOR' },
      });
      expect(modRoleDenied.statusCode).toBe(403);

      // Platform Admin cannot escalate self or target to SUPER_ADMIN (403)
      const escDenied = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${platAdmin.userId}/roles`,
        headers: { cookie: platAdmin.cookie, 'x-csrf-token': platAdmin.csrf },
        payload: { roleName: 'SUPER_ADMIN' },
      });
      expect(escDenied.statusCode).toBe(403);

      // Platform Admin CAN assign CHALLENGE_AUTHOR to target
      const assignOk = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${target.userId}/roles`,
        headers: { cookie: platAdmin.cookie, 'x-csrf-token': platAdmin.csrf },
        payload: { roleName: 'CHALLENGE_AUTHOR' },
      });
      expect(assignOk.statusCode).toBe(200);

      // Platform Admin CANNOT revoke roles from Super Admin
      const modSaDenied = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/users/${superAdmin.userId}/roles/SUPER_ADMIN`,
        headers: { cookie: platAdmin.cookie, 'x-csrf-token': platAdmin.csrf },
      });
      expect(modSaDenied.statusCode).toBe(403);

      // Last active Super Admin cannot be stripped of SUPER_ADMIN if only 1 active exists
      const activeSuperCount = await prisma.userRole.count({
        where: { role: { name: 'SUPER_ADMIN' }, user: { accountStatus: 'ACTIVE', deletedAt: null } },
      });
      if (activeSuperCount === 1) {
        const lastSaRevoke = await ctx.app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/users/${superAdmin.userId}/roles/SUPER_ADMIN`,
          headers: { cookie: superAdmin.cookie, 'x-csrf-token': superAdmin.csrf },
        });
        expect(lastSaRevoke.statusCode).toBe(409);
        expect(lastSaRevoke.json().error.code).toBe('LAST_SUPER_ADMIN_PROTECTED');
      }
    } finally {
      await ctx.app.close();
    }
  });

  it('suspends, revokes active sessions, blocks login, auto-expires temporary suspensions, bans, restores, and handles concurrent actions', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const admin = await createUser(ctx, 'm_adm', 'PLATFORM_ADMIN');
      const target = await createUser(ctx, 'm_tgt');

      // 1. Concurrent suspend requests -> only ONE succeeds (200), second hits CONCURRENT_MODIFICATION (409) or INVALID_STATUS_TRANSITION (400)
      const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const [s1, s2] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/admin/users/${target.userId}/suspend`,
          headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
          payload: { reason: 'Automated brute force attempt', expiresAt: futureIso },
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/admin/users/${target.userId}/suspend`,
          headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
          payload: { reason: 'Duplicate suspend request', expiresAt: futureIso },
        }),
      ]);
      expect([s1.statusCode, s2.statusCode].sort()[0]).toBe(200);
      expect([s1.statusCode, s2.statusCode].sort()[1]).toBeGreaterThanOrEqual(400);

      // 2. Existing session cookie immediately rejected
      const activeCheck = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: target.cookie },
      });
      expect(activeCheck.statusCode).toBe(401);

      // 3. Login rejected while suspension is active
      const blockedLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: target.username, password: target.password },
      });
      expect(blockedLogin.statusCode).toBe(403);

      // 4. Temporary suspension expires -> login auto-restores account
      await prisma.user.update({
        where: { id: target.userId },
        data: { suspendedUntil: new Date(Date.now() - 5000) },
      });
      const expiredLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: target.username, password: target.password },
      });
      expect(expiredLogin.statusCode).toBe(200);
      const freshCookie = cookieOf(expiredLogin);

      // 5. Ban revokes fresh session and rejects login
      const banRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${target.userId}/ban`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: { reason: 'Repeated infrastructure abuse' },
      });
      expect(banRes.statusCode).toBe(200);

      const postBanMe = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: freshCookie },
      });
      expect(postBanMe.statusCode).toBe(401);

      const postBanLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: target.username, password: target.password },
      });
      expect(postBanLogin.statusCode).toBe(403);

      // 6. Restore allows new login while old session stays revoked
      const restoreRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${target.userId}/restore`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: { reason: 'Appeal verified and accepted' },
      });
      expect(restoreRes.statusCode).toBe(200);

      const oldCookieAfterRestore = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        headers: { cookie: freshCookie },
      });
      expect(oldCookieAfterRestore.statusCode).toBe(401);

      const newLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: target.username, password: target.password },
      });
      expect(newLogin.statusCode).toBe(200);

      // 7. Moderation history & audit logs preserved
      const detail = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/users/${target.userId}`,
        headers: { cookie: admin.cookie },
      });
      expect(detail.json().user.moderationHistory.length).toBeGreaterThanOrEqual(4);
    } finally {
      await ctx.app.close();
    }
  });
});
