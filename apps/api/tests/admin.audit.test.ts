import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.4 — Audit Log Filtering, Pagination, Redaction & Immutability', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0020',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00020',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupLogIds: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `al_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AuditStrongPassword!123';
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
    if (cleanupLogIds.length) {
      await prisma.auditLog.deleteMany({ where: { id: { in: cleanupLogIds } } });
    }
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await prisma.$disconnect();
  });

  it('filters by actor/category/action/entity/dates, paginates, redacts secrets, and blocks mutations', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const superAdmin = await createUser(ctx, 'sa', 'SUPER_ADMIN');
      const organizer = await createUser(ctx, 'org', 'COMPETITION_ORGANIZER');
      const player = await createUser(ctx, 'ply');

      // 1. Unauthorized roles denied (401 / 403)
      const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs' });
      expect(anon.statusCode).toBe(401);

      const pDenied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs',
        headers: { cookie: player.cookie },
      });
      expect(pDenied.statusCode).toBe(403);

      const orgDenied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs',
        headers: { cookie: organizer.cookie },
      });
      expect(orgDenied.statusCode).toBe(403);

      // 2. Record audit event containing nested sensitive keys to verify deep redaction
      await ctx.auditService.record({
        actorId: superAdmin.userId,
        actorRole: 'SUPER_ADMIN',
        category: 'SCORING',
        action: `SCORE_DISPUTE_TEST_${suffix.toUpperCase()}`,
        entityType: 'ScoreTransaction',
        entityId: `ent_${suffix}`,
        previousValues: { points: 100, flagValue: 'DUSK{should_never_appear}' },
        newValues: { points: 150, nested: { passwordHash: 'secret-hash', sessionToken: 'tok-123' } },
        metadata: { reason: 'Audit redaction test', apiKey: 'sk-live-secret' },
        correlationId: `corr-${suffix}`,
      });

      // 3. Invalid filter (endDate < startDate, limit > 100) rejected with 400
      const badDates = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs?startDate=2026-05-10T00:00:00.000Z&endDate=2026-05-01T00:00:00.000Z',
        headers: { cookie: superAdmin.cookie },
      });
      expect(badDates.statusCode).toBe(400);

      const badLimit = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs?limit=500',
        headers: { cookie: superAdmin.cookie },
      });
      expect(badLimit.statusCode).toBe(400);

      // 4. Filter by actor, category, entityId, and date range
      const startIso = new Date(Date.now() - 60_000).toISOString();
      const endIso = new Date(Date.now() + 60_000).toISOString();
      const qRes = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-logs?actor=${superAdmin.username}&category=SCORING&entityType=ScoreTransaction&entityId=ent_${suffix}&startDate=${encodeURIComponent(startIso)}&endDate=${encodeURIComponent(endIso)}&page=1&limit=10`,
        headers: { cookie: superAdmin.cookie },
      });
      expect(qRes.statusCode).toBe(200);
      expect(qRes.json().logs).toHaveLength(1);

      const log = qRes.json().logs[0];
      expect(log.correlationId).toBe(`corr-${suffix}`);
      expect(log.previousValues.flagValue).toBe('[REDACTED]');
      expect(log.newValues.nested.passwordHash).toBe('[REDACTED]');
      expect(log.newValues.nested.sessionToken).toBe('[REDACTED]');
      expect(log.metadata.apiKey).toBe('[REDACTED]');
      expect(JSON.stringify(log)).not.toContain('DUSK{should_never_appear}');
      expect(JSON.stringify(log)).not.toContain('sk-live-secret');

      // 5. Detail endpoint respects RBAC & returns redacted record
      const detailDenied = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-logs/${log.id}`,
        headers: { cookie: player.cookie },
      });
      expect(detailDenied.statusCode).toBe(403);

      const detailOk = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/audit-logs/${log.id}`,
        headers: { cookie: superAdmin.cookie },
      });
      expect(detailOk.statusCode).toBe(200);
      expect(detailOk.json().log.id).toBe(log.id);

      // 6. Immutability: even Super Admin cannot PATCH or DELETE audit records (405)
      const patchTry = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/audit-logs/${log.id}`,
        headers: { cookie: superAdmin.cookie },
        payload: { action: 'TAMPERED' },
      });
      expect(patchTry.statusCode).toBe(405);

      const delTry = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/admin/audit-logs/${log.id}`,
        headers: { cookie: superAdmin.cookie },
      });
      expect(delTry.statusCode).toBe(405);
    } finally {
      await ctx.app.close();
    }
  });
});
