import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) return '';
  return raw.split(';')[0] ?? '';
}

describe('Auth, Session, CSRF, RBAC & Rate-Limit Security', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0001',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00001',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  let appCtx: Awaited<ReturnType<typeof buildApp>>;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    appCtx = await buildApp({ env, prisma, authRateLimitMax: 50 });
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await appCtx.app.close();
    await prisma.$disconnect();
  });

  it('registers user, verifies email, logs in with HttpOnly cookie, and never exposes passwordHash', async () => {
    const email = `p1_${suffix}@dusklabs.local`;
    const username = `player1_${suffix}`;
    const password = 'CorrectHorseBatteryStaple!99';

    const regRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: 'Player One', email, password, country: 'US' },
    });

    expect(regRes.statusCode).toBe(201);
    const regBody = regRes.json();
    expect(regBody.user.passwordHash).toBeUndefined();
    createdUserIds.push(regBody.user.id);

    const verifyToken = appCtx.authService.devOutbox.emailVerifyTokens.get(email);
    expect(verifyToken).toBeDefined();

    const verifyRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    expect(verifyRes.statusCode).toBe(200);

    const loginRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.headers['x-frame-options']).toBe('DENY');
    expect(loginRes.headers['x-content-type-options']).toBe('nosniff');

    const rawSetCookie = String(loginRes.headers['set-cookie']);
    expect(rawSetCookie.toLowerCase()).toContain('httponly');
    const cookie = extractCookie(loginRes.headers['set-cookie']);
    const { csrfToken } = loginRes.json();

    const meRes = await appCtx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.roles).toContain('PARTICIPANT');

    // CSRF Protection: reject logout without CSRF token
    const badLogout = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(badLogout.statusCode).toBe(403);

    // CSRF Protection: allow logout with valid CSRF token
    const goodLogout = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    expect(goodLogout.statusCode).toBe(200);

    // Revoked session must be rejected
    const afterLogout = await appCtx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('enforces RBAC on administrative endpoints and blocks participant escalation', async () => {
    const email = `rbac_${suffix}@dusklabs.local`;
    const username = `rbac_${suffix}`;
    const password = 'StrongPassword#2025!Secure';

    const regRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: 'RBAC Test', email, password },
    });
    const userId = regRes.json().user.id;
    createdUserIds.push(userId);

    const login1 = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: email, password },
    });
    const cookie = extractCookie(login1.headers['set-cookie']);

    // Participant blocked from admin endpoint
    const denied = await appCtx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/ping',
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(403);

    // Grant SUPER_ADMIN in DB and confirm access
    const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    await prisma.userRole.create({ data: { userId, roleId: superAdminRole.id } });

    const allowed = await appCtx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/ping',
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().authorized).toBe(true);
  });

  it('locks account after 5 consecutive failed logins and supports password reset session revocation', async () => {
    const email = `lock_${suffix}@dusklabs.local`;
    const username = `lock_${suffix}`;
    const password = 'InitialPassword!12345';

    const regRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: 'Lock Test', email, password },
    });
    createdUserIds.push(regRes.json().user.id);

    const validLogin = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });
    const activeCookie = extractCookie(validLogin.headers['set-cookie']);

    for (let i = 0; i < 5; i++) {
      const fail = await appCtx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: username, password: 'WrongPassword123' },
      });
      expect(fail.statusCode).toBe(401);
    }

    const lockedRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });
    expect(lockedRes.statusCode).toBe(403);
    expect(lockedRes.json().error.code).toBe('ACCOUNT_LOCKED');

    // Password reset unlocks account & revokes active sessions
    await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email },
    });
    const resetToken = appCtx.authService.devOutbox.passwordResetTokens.get(email);
    expect(resetToken).toBeDefined();

    const resetRes = await appCtx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'RotatedPassword!98765' },
    });
    expect(resetRes.statusCode).toBe(200);

    const oldSessionCheck = await appCtx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: activeCookie },
    });
    expect(oldSessionCheck.statusCode).toBe(401);
  });

  it('enforces endpoint rate limiting on login attempts', async () => {
    const strictCtx = await buildApp({ env, prisma, authRateLimitMax: 2 });
    try {
      await strictCtx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'nobody', password: 'bad' },
      });
      await strictCtx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'nobody', password: 'bad' },
      });
      const third = await strictCtx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: 'nobody', password: 'bad' },
      });
      expect(third.statusCode).toBe(429);
    } finally {
      await strictCtx.app.close();
    }
  });
});
