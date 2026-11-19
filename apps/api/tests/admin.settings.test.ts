import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.6 — Platform Settings RBAC, Enforcement & Audit Trail', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0022',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00022',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `st_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'SettingsStrongPass!123';
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
    return { userId, username, email, password, cookie: cookieOf(login), csrf: login.json().csrfToken as string };
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.platformSettings.deleteMany({ where: { id: 'default' } });
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await prisma.$disconnect();
  });

  it('restricts admin settings exclusively to SUPER_ADMIN, enforces toggles, and records audit diffs', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, contactRateLimitMax: 50 });
    try {
      const superAdmin = await createUser(ctx, 'sa', 'SUPER_ADMIN');
      const platAdmin = await createUser(ctx, 'pa', 'PLATFORM_ADMIN');
      const player = await createUser(ctx, 'ply');

      // 1. PLATFORM_ADMIN and PARTICIPANT blocked from reading/updating settings (403)
      for (const actor of [platAdmin, player]) {
        const gRes = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/settings',
          headers: { cookie: actor.cookie },
        });
        expect(gRes.statusCode).toBe(403);

        const pRes = await ctx.app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/settings',
          headers: { cookie: actor.cookie, 'x-csrf-token': actor.csrf },
          payload: { registrationEnabled: false },
        });
        expect(pRes.statusCode).toBe(403);
      }

      // 2. SUPER_ADMIN reads defaults and disables registration, team creation, contact, and enforces email verification
      const getOk = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/settings',
        headers: { cookie: superAdmin.cookie },
      });
      expect(getOk.statusCode).toBe(200);
      expect(getOk.json().settings.platformName).toBe('DuskLabs');

      const patchOk = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/settings',
        headers: { cookie: superAdmin.cookie, 'x-csrf-token': superAdmin.csrf },
        payload: {
          registrationEnabled: false,
          requireEmailVerificationForLogin: true,
          teamCreationEnabled: false,
          contactFormEnabled: false,
          maintenanceMode: true,
          maintenanceMessage: 'Scheduled database maintenance.',
        },
      });
      expect(patchOk.statusCode).toBe(200);

      // 3. Public settings reflect safe subset
      const pubRes = await ctx.app.inject({ method: 'GET', url: '/api/v1/settings/public' });
      expect(pubRes.statusCode).toBe(200);
      expect(pubRes.json().settings.maintenanceMode).toBe(true);
      expect(pubRes.json().settings.flagSubmissionMaxAttemptsPerMin).toBeUndefined();

      // Maintenance mode intentionally short-circuits participant writes with 503, so
      // leave it before exercising the individual feature toggles below.
      const maintenanceOff = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/v1/admin/settings',
        headers: { cookie: superAdmin.cookie, 'x-csrf-token': superAdmin.csrf },
        payload: { maintenanceMode: false },
      });
      expect(maintenanceOff.statusCode).toBe(200);

      // 4. Enforcement checks
      const blockedReg = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          username: `blk_${suffix}`,
          displayName: 'Blocked',
          email: `blk_${suffix}@dusklabs.local`,
          password: 'BlockedPassword!123',
        },
      });
      expect(blockedReg.statusCode).toBe(403);
      expect(blockedReg.json().error.code).toBe('REGISTRATION_DISABLED');

      // Unverified player login blocked while requireEmailVerificationForLogin=true
      const unverifiedLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: player.username, password: player.password },
      });
      expect(unverifiedLogin.statusCode).toBe(403);
      expect(unverifiedLogin.json().error.code).toBe('EMAIL_VERIFICATION_REQUIRED');

      const blockedTeam = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { name: `BlkTeam_${suffix}` },
      });
      expect(blockedTeam.statusCode).toBe(403);

      const blockedContact = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        payload: {
          name: 'Visitor',
          email: 'visitor@example.org',
          category: 'GENERAL',
          subject: 'Disabled Form',
          message: 'Should be rejected while contactFormEnabled is false.',
        },
      });
      expect(blockedContact.statusCode).toBe(403);

      // 5. Audit log recorded previousValues & newValues
      const audit = await prisma.auditLog.findFirst({
        where: {
          action: 'PLATFORM_SETTINGS_UPDATED',
          actorId: superAdmin.userId,
          newValues: { contains: '"registrationEnabled":false' },
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect(audit!.previousValues).toContain('"registrationEnabled":true');
      expect(audit!.newValues).toContain('"registrationEnabled":false');

      // 6. Reset defaults
      const resetRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/admin/settings/reset',
        headers: { cookie: superAdmin.cookie, 'x-csrf-token': superAdmin.csrf },
      });
      expect(resetRes.statusCode).toBe(200);
      expect(resetRes.json().settings.registrationEnabled).toBe(true);
    } finally {
      await ctx.app.close();
    }
  });
});
