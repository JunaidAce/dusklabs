import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.1 — Competition CRUD, Timezones, Visibility & Multi-Organizer RBAC', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0010',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00010',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupComps: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `cp_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'CompStrongPassword!123';
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

  it('validates dates/timezone, enforces RBAC/IDOR, manages organizers, and controls visibility', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const org1 = await createUser(ctx, 'org1', 'COMPETITION_ORGANIZER');
      const org2 = await createUser(ctx, 'org2', 'COMPETITION_ORGANIZER');
      const player = await createUser(ctx, 'ply');

      const startIso = new Date(Date.now() + 3_600_000).toISOString();
      const endIso = new Date(Date.now() + 7_200_000).toISOString();

      // Participant blocked (403)
      const denied = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/competitions',
        headers: { cookie: player.cookie, 'x-csrf-token': player.csrf },
        payload: {
          slug: `denied-${suffix}`,
          title: 'Denied Comp',
          description: 'Unauthorized creation attempt.',
          rules: 'Standard rules apply here.',
          participationMode: 'TEAM',
          startsAt: startIso,
          endsAt: endIso,
        },
      });
      expect(denied.statusCode).toBe(403);

      // Invalid IANA timezone rejected (400)
      const badTz = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/competitions',
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: {
          slug: `badtz-${suffix}`,
          title: 'Bad Timezone Comp',
          description: 'Invalid timezone should fail validation.',
          rules: 'Standard rules apply here.',
          timezone: 'Mars/Olympus',
          participationMode: 'TEAM',
          startsAt: startIso,
          endsAt: endIso,
        },
      });
      expect(badTz.statusCode).toBe(400);

      // Valid creation in DRAFT (hidden)
      const createRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/competitions',
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: {
          slug: `autumn-ctf-${suffix}`,
          title: 'DuskLabs Autumn Open',
          description: 'University cybersecurity competition covering Jeopardy domains.',
          rules: 'No flag sharing or infrastructure tampering.',
          timezone: 'America/New_York',
          participationMode: 'TEAM',
          minTeamSize: 1,
          maxTeamSize: 4,
          scoringMode: 'DYNAMIC',
          startsAt: startIso,
          endsAt: endIso,
        },
      });
      expect(createRes.statusCode).toBe(201);
      const compId = createRes.json().competition.id as string;
      cleanupComps.push(compId);

      // Hidden DRAFT returns 404 to public & org2
      const hiddenView = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/autumn-ctf-${suffix}`,
        headers: { cookie: player.cookie },
      });
      expect(hiddenView.statusCode).toBe(404);

      // IDOR: org2 cannot edit org1's competition before assignment
      const idorEdit = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/competitions/${compId}`,
        headers: { cookie: org2.cookie, 'x-csrf-token': org2.csrf },
        payload: { title: 'Hijacked Title' },
      });
      expect(idorEdit.statusCode).toBe(403);

      // org1 assigns org2 as co-organizer -> org2 can now edit & publish
      const assignRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/organizers`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
        payload: { userId: org2.userId },
      });
      expect(assignRes.statusCode).toBe(200);

      const org2Edit = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/competitions/${compId}`,
        headers: { cookie: org2.cookie, 'x-csrf-token': org2.csrf },
        payload: { maxTeamSize: 5 },
      });
      expect(org2Edit.statusCode).toBe(200);
      expect(org2Edit.json().competition.maxTeamSize).toBe(5);

      const pubRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/publish`,
        headers: { cookie: org2.cookie, 'x-csrf-token': org2.csrf },
      });
      expect(pubRes.statusCode).toBe(200);
      expect(pubRes.json().competition.isVisible).toBe(true);
      expect(pubRes.json().competition.status).toBe('SCHEDULED');

      // Now visible publicly
      const publicView = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/competitions/autumn-ctf-${suffix}`,
      });
      expect(publicView.statusCode).toBe(200);
      expect(publicView.json().competition.timezone).toBe('America/New_York');

      // Cannot hard-delete non-DRAFT competition -> must archive
      const delNonDraft = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/competitions/${compId}`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
      });
      expect(delNonDraft.statusCode).toBe(409);

      const archRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/competitions/${compId}/archive`,
        headers: { cookie: org1.cookie, 'x-csrf-token': org1.csrf },
      });
      expect(archRes.statusCode).toBe(200);
      expect(archRes.json().competition.status).toBe('ARCHIVED');
    } finally {
      await ctx.app.close();
    }
  });
});
