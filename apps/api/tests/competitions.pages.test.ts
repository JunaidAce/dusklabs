import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.4 — Competition Listing Phase Filters & Announcements Endpoint', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0013',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00013',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (cleanupComps.length) await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('filters visible competitions by phase and protects draft announcements', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const username = `pg_org_${suffix}`;
      const reg = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { username, displayName: 'Page Org', email: `${username}@dusklabs.local`, password: 'PageStrongPassword!123' },
      });
      const orgId = reg.json().user.id as string;
      cleanupUsers.push(orgId);

      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'COMPETITION_ORGANIZER' } });
      await prisma.userRole.create({ data: { userId: orgId, roleId: role.id } });

      const login = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { identifier: username, password: 'PageStrongPassword!123' },
      });
      const orgCookie = cookieOf(login);

      const now = Date.now();
      const liveComp = await prisma.competition.create({
        data: {
          slug: `pg-live-${suffix}`,
          title: 'Live Phase Comp',
          description: 'Currently live',
          rules: 'Rules',
          status: 'LIVE',
          isVisible: true,
          startsAt: new Date(now - 60_000),
          endsAt: new Date(now + 3_600_000),
          createdById: orgId,
        },
      });
      const draftComp = await prisma.competition.create({
        data: {
          slug: `pg-draft-${suffix}`,
          title: 'Draft Hidden Comp',
          description: 'Hidden draft',
          rules: 'Rules',
          status: 'DRAFT',
          isVisible: false,
          startsAt: new Date(now + 3_600_000),
          endsAt: new Date(now + 7_200_000),
          createdById: orgId,
        },
      });
      cleanupComps.push(liveComp.id, draftComp.id);

      await prisma.announcement.createMany({
        data: [
          { competitionId: liveComp.id, authorId: orgId, title: 'Clarification', body: 'Check hints.', isPinned: true },
          { competitionId: draftComp.id, authorId: orgId, title: 'Secret Draft Notice', body: 'Hidden' },
        ],
      });

      const liveList = await ctx.app.inject({ method: 'GET', url: '/api/v1/competitions?phase=LIVE' });
      expect(liveList.statusCode).toBe(200);
      expect(liveList.json().competitions.some((c: any) => c.id === liveComp.id)).toBe(true);
      expect(liveList.json().competitions.some((c: any) => c.id === draftComp.id)).toBe(false);

      const publicAnn = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/pg-live-${suffix}/announcements`,
      });
      expect(publicAnn.statusCode).toBe(200);
      expect(publicAnn.json().announcements).toHaveLength(1);
      expect(publicAnn.json().announcements[0].isPinned).toBe(true);

      // Draft announcements hidden from public (404) but visible to owning organizer (200)
      const hiddenAnn = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/pg-draft-${suffix}/announcements`,
      });
      expect(hiddenAnn.statusCode).toBe(404);

      const orgAnn = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/pg-draft-${suffix}/announcements`,
        headers: { cookie: orgCookie },
      });
      expect(orgAnn.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });
});
