import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 4 Step 4.7 — Contact Inquiries, Validation, Rate Limiting & RBAC', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0016',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00016',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupInquiries: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `ct_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'ContactStrongPassword!123';
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
    if (cleanupInquiries.length) {
      await prisma.contactInquiry.deleteMany({ where: { id: { in: cleanupInquiries } } });
    }
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await prisma.$disconnect();
  });

  it('persists public & authenticated inquiries, enforces honeypot/validation, and restricts admin review via RBAC', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, contactRateLimitMax: 20 });
    try {
      const mod = await createUser(ctx, 'mod', 'MODERATOR');
      const player = await createUser(ctx, 'ply');

      // 1. Validation & honeypot rejection
      const invalidRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        payload: {
          name: 'A',
          email: 'not-an-email',
          category: 'GENERAL',
          subject: 'Hi',
          message: 'Too short',
        },
      });
      expect(invalidRes.statusCode).toBe(400);

      const spamRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        payload: {
          name: 'Spam Bot',
          email: 'bot@example.com',
          category: 'GENERAL',
          subject: 'Automated message',
          message: 'This message fills the hidden honeypot field.',
          website: 'https://spam.example.com',
        },
      });
      expect(spamRes.statusCode).toBe(400);

      // 2. Unauthenticated public contact submission
      const anonRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        payload: {
          name: 'External Researcher',
          email: 'researcher@example.org',
          category: 'SECURITY_DISCLOSURE',
          subject: 'Responsible Disclosure Inquiry',
          message: 'Requesting PGP contact instructions for responsible disclosure.',
        },
      });
      expect(anonRes.statusCode).toBe(201);
      const anonId = anonRes.json().inquiry.id as string;
      cleanupInquiries.push(anonId);

      // Verify IP is stored hashed, not plaintext
      const dbAnon = await prisma.contactInquiry.findUniqueOrThrow({ where: { id: anonId } });
      expect(dbAnon.ipHash).toHaveLength(64);
      expect(dbAnon.ipHash).not.toBe('127.0.0.1');

      // 3. Authenticated submission linked server-side to player.userId
      const authRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/contact',
        headers: { cookie: player.cookie },
        payload: {
          name: 'Player One',
          email: 'player@dusklabs.local',
          category: 'COMPETITION',
          subject: 'Team Size Clarification',
          message: 'Can university guests register in team mode competitions?',
        },
      });
      expect(authRes.statusCode).toBe(201);
      const playerInqId = authRes.json().inquiry.id as string;
      cleanupInquiries.push(playerInqId);

      // 4. RBAC: participant blocked from admin inquiry listing/updating
      const pAdminList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/contact-inquiries',
        headers: { cookie: player.cookie },
      });
      expect(pAdminList.statusCode).toBe(403);

      // 5. Moderator can review and resolve inquiry; adminNotes never exposed in /contact/my
      const modList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/contact-inquiries?status=OPEN',
        headers: { cookie: mod.cookie },
      });
      expect(modList.statusCode).toBe(200);
      expect(modList.json().inquiries.some((i: any) => i.id === playerInqId)).toBe(true);

      const modUpdate = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/contact-inquiries/${playerInqId}`,
        headers: { cookie: mod.cookie, 'x-csrf-token': mod.csrf },
        payload: { status: 'RESOLVED', adminNotes: 'Internal: answered via FAQ.' },
      });
      expect(modUpdate.statusCode).toBe(200);
      expect(modUpdate.json().inquiry.status).toBe('RESOLVED');

      const myRes = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/contact/my',
        headers: { cookie: player.cookie },
      });
      expect(myRes.statusCode).toBe(200);
      expect(myRes.json().inquiries).toHaveLength(1);
      expect(myRes.json().inquiries[0].status).toBe('RESOLVED');
      expect(JSON.stringify(myRes.json())).not.toContain('Internal: answered via FAQ.');
    } finally {
      await ctx.app.close();
    }
  });

  it('enforces rate limiting on public contact submissions', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, contactRateLimitMax: 2 });
    try {
      const payload = {
        name: 'Rate Limit Tester',
        email: 'rl@example.org',
        category: 'GENERAL',
        subject: 'Rate Limit Check',
        message: 'Testing repeated submissions to verify 429 protection.',
      };

      const r1 = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact', payload });
      const r2 = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact', payload });
      if (r1.statusCode === 201) cleanupInquiries.push(r1.json().inquiry.id);
      if (r2.statusCode === 201) cleanupInquiries.push(r2.json().inquiry.id);

      const r3 = await ctx.app.inject({ method: 'POST', url: '/api/v1/contact', payload });
      expect(r3.statusCode).toBe(429);
    } finally {
      await ctx.app.close();
    }
  });
});
