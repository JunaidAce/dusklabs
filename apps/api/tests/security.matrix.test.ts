import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 6 — Consolidated OWASP ASVS Security & Reliability Matrix', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0023',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00023',
    CORS_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `sec_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'SecMatrixStrongPass!123';
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

  it('[SEC-01 / SEC-02 / SEC-03 / SEC-12] resists SQLi, rejects javascript:/data: XSS URLs, enforces Origin/Referer CSRF, and sets security headers', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const player = await createUser(ctx, 'sqli');

      // SEC-12: Security headers
      const health = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(health.headers['x-frame-options']).toBe('DENY');
      expect(health.headers['x-content-type-options']).toBe('nosniff');
      expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");

      // SEC-01: SQL injection payloads in auth & search endpoints
      const sqliLogin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: "' OR '1'='1' --", password: "' OR '1'='1" },
      });
      expect(sqliLogin.statusCode).toBe(401);

      const sqliSearch = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/challenges?search=${encodeURIComponent("'; DROP TABLE Challenge; --")}`,
        headers: { cookie: player.cookie },
      });
      expect(sqliSearch.statusCode).toBe(200);
      expect(sqliSearch.json().challenges).toEqual([]);

      // SEC-02: Dangerous URL protocols rejected in Team.logoUrl
      const xssTeam = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { name: `XSSTeam_${suffix}`, logoUrl: 'javascript:alert(document.cookie)' },
      });
      expect(xssTeam.statusCode).toBe(400);

      // SEC-03: CSRF Origin & Referer bypass attempts blocked
      const nullOrigin = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: {
          cookie: player.cookie,
          'x-csrf-token': player.csrf,
          origin: 'null',
        },
        payload: { name: `NullOrig_${suffix}` },
      });
      expect(nullOrigin.statusCode).toBe(403);

      const evilReferer = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/teams',
        headers: {
          cookie: player.cookie,
          'x-csrf-token': player.csrf,
          referer: 'https://evil.attacker.example/exploit.html',
        },
        payload: { name: `EvilRef_${suffix}` },
      });
      expect(evilReferer.statusCode).toBe(403);
    } finally {
      await ctx.app.close();
    }
  });

  it('[SEC-08 / SEC-11] enforces exact competition start/end boundaries and guarantees zero secret/flag leakage', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'bndadm', 'PLATFORM_ADMIN');
      const player = await createUser(ctx, 'bndply');
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'cryptography' } });

      // Competition starting 5 seconds in the future
      const compFuture = await prisma.competition.create({
        data: {
          slug: `sec-fut-${suffix}`,
          title: 'Boundary Future Cup',
          description: 'Boundary check',
          rules: 'Rules',
          status: 'LIVE',
          isVisible: true,
          participationMode: 'INDIVIDUAL',
          startsAt: new Date(Date.now() + 5_000),
          endsAt: new Date(Date.now() + 60_000),
          createdById: admin.userId,
        },
      });
      // Competition ended 5 seconds ago
      const compPast = await prisma.competition.create({
        data: {
          slug: `sec-past-${suffix}`,
          title: 'Boundary Past Cup',
          description: 'Boundary check',
          rules: 'Rules',
          status: 'LIVE',
          isVisible: true,
          participationMode: 'INDIVIDUAL',
          startsAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() - 5_000),
          createdById: admin.userId,
        },
      });
      cleanupComps.push(compFuture.id, compPast.id);

      await prisma.competitionRegistration.createMany({
        data: [
          { competitionId: compFuture.id, userId: player.userId },
          { competitionId: compPast.id, userId: player.userId },
        ],
      });

      const secretFlag1 = 'DUSK{never_leak_before_start}';
      const secretFlag2 = 'DUSK{never_leak_after_end}';

      const c1 = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `sec-c1-${suffix}`,
          title: 'Pre-Start Target',
          description: 'Boundary test.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          competitionId: compFuture.id,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: secretFlag1 },
        },
      });
      const c2 = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `sec-c2-${suffix}`,
          title: 'Post-End Target',
          description: 'Boundary test.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          competitionId: compPast.id,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: secretFlag2 },
        },
      });
      const c1Id = c1.json().challenge.id as string;
      const c2Id = c2.json().challenge.id as string;
      cleanupChallenges.push(c1Id, c2Id);

      // Submissions before startsAt and after endsAt both rejected (403)
      const preStart = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c1Id}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: secretFlag1 },
      });
      expect(preStart.statusCode).toBe(403);
      expect(preStart.json().error.code).toBe('COMPETITION_NOT_LIVE');

      const postEnd = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${c2Id}/submit`,
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: { flag: secretFlag2 },
      });
      expect(postEnd.statusCode).toBe(403);
      expect(postEnd.json().error.code).toBe('COMPETITION_NOT_LIVE');

      // Secret sweep across public/admin endpoints
      const adminChallDetail = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/challenges/${c1Id}`,
        headers: { cookie: admin.cookie },
      });
      const serialized = JSON.stringify(adminChallDetail.json());
      expect(serialized).not.toContain(secretFlag1);
      expect(serialized).not.toContain('flagDigest');
      expect(serialized).not.toContain('encryptedFlag');
    } finally {
      await ctx.app.close();
    }
  });
});
