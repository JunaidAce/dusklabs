import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

describe('Phase 5 Step 5.3 — Submission Inspector, Disputes, Reports, ContactInquiries & Privacy', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const env = loadEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0019',
    FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00019',
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
  });

  const cleanupUsers: string[] = [];
  const cleanupChallenges: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `md_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'ModStrongPassword!123';
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
    // Restrict-FK children must be cleared before users: dispute corrections
    // (SubmissionDisputeCorrection.admin), reports (Report.reporter/resolvedBy),
    // and the untracked competition created via prisma (Competition.createdBy).
    await prisma.submissionDisputeCorrection.deleteMany({ where: { adminId: { in: cleanupUsers } } });
    await prisma.report.deleteMany({
      where: { OR: [{ reporterId: { in: cleanupUsers } }, { resolvedById: { in: cleanupUsers } }] },
    });
    if (cleanupChallenges.length) await prisma.challenge.deleteMany({ where: { id: { in: cleanupChallenges } } });
    await prisma.competition.deleteMany({ where: { createdById: { in: cleanupUsers } } });
    if (cleanupUsers.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    await prisma.$disconnect();
  });

  it('inspects submissions, detects suspicious bursts, resolves disputes immutably, and protects reporter privacy', async () => {
    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100, submitRateLimitMax: 50 });
    try {
      const admin = await createUser(ctx, 'adm', 'PLATFORM_ADMIN');
      const mod = await createUser(ctx, 'mod', 'MODERATOR');
      const org = await createUser(ctx, 'org', 'COMPETITION_ORGANIZER');
      const p1 = await createUser(ctx, 'p1');
      const p2 = await createUser(ctx, 'p2');
      const cat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const cRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `md-chal-${suffix}`,
          title: 'Moderation Inspector Target',
          description: 'Submit wrong flags for burst inspection.',
          difficulty: 'EASY',
          status: 'PUBLISHED',
          isVisible: true,
          points: 100,
          initialPoints: 100,
          categoryIds: [cat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{secret_mod_flag}' },
        },
      });
      const chalId = cRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // p1 fires 5 wrong attempts (triggers RAPID_SUBMISSION_BURST heuristic)
      for (let i = 0; i < 5; i++) {
        await ctx.app.inject({
          method: 'POST',
          url: `/api/v1/challenges/${chalId}/submit`,
          headers: { cookie: p1.cookie, 'x-csrf-token': p1.csrf },
          payload: { flag: `DUSK{bad_${i}}` },
        });
      }

      // Participant blocked from admin submission inspector (403)
      const pDenied = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/submissions',
        headers: { cookie: p1.cookie },
      });
      expect(pDenied.statusCode).toBe(403);

      // Moderator searches submissions by username -> sees p1's failed submissions, zero flag secrets
      const subList = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/admin/submissions?search=${p1.username}&isCorrect=false`,
        headers: { cookie: mod.cookie },
      });
      expect(subList.statusCode).toBe(200);
      expect(subList.json().submissions.length).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(subList.json())).not.toContain('DUSK{secret_mod_flag}');

      const firstSubId = subList.json().submissions[0].id as string;

      // Suspicious activity lists p1 with RAPID_SUBMISSION_BURST without auto-banning
      const suspRes = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/moderation/suspicious',
        headers: { cookie: mod.cookie },
      });
      expect(suspRes.statusCode).toBe(200);
      const alert = suspRes.json().alerts.find((a: any) => a.userId === p1.userId);
      expect(alert).toBeDefined();
      expect(alert.accountStatus).toBe('ACTIVE');
      expect(alert.reasons).toContain('RAPID_SUBMISSION_BURST');

      // Moderator lacks score:adjust -> blocked from crediting dispute points (403)
      const modDisputeDenied = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/submissions/${firstSubId}/dispute`,
        headers: { cookie: mod.cookie, 'x-csrf-token': mod.csrf },
        payload: { action: 'CREDIT_POINTS', deltaPoints: 100, reason: 'Testing RBAC' },
      });
      expect(modDisputeDenied.statusCode).toBe(403);

      // Platform Admin credits dispute points while preserving original Submission row (isCorrect stays false)
      const admDisputeOk = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/admin/submissions/${firstSubId}/dispute`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          action: 'CREDIT_POINTS',
          deltaPoints: 100,
          reason: 'Accepted alternate flag formatting dispute',
        },
      });
      expect(admDisputeOk.statusCode).toBe(200);

      const origSub = await prisma.submission.findUniqueOrThrow({ where: { id: firstSubId } });
      expect(origSub.isCorrect).toBe(false); // Original evidence untouched

      const ledgerSum = await prisma.scoreTransaction.aggregate({
        where: { userId: p1.userId },
        _sum: { deltaPoints: true },
      });
      expect(ledgerSum._sum.deltaPoints).toBe(100);

      // Anonymous report filed by p2 against p1
      const comp = await prisma.competition.create({
        data: {
          slug: `md-comp-${suffix}`,
          title: 'Report Scope Comp',
          description: 'Test',
          rules: 'Test',
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 3_600_000),
          createdById: org.userId,
        },
      });
      const repRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/reports',
        headers: { cookie: p2.cookie, 'x-csrf-token': p2.csrf },
        payload: {
          competitionId: comp.id,
          targetUserId: p1.userId,
          category: 'CHEATING',
          description: 'Suspected flag sharing in public channel.',
          isAnonymous: true,
        },
      });
      expect(repRes.statusCode).toBe(201);
      const reportId = repRes.json().report.id as string;

      // Organizer sees ANONYMOUS_REPORTER (privacy protected), Platform Admin sees p2
      const orgRepList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/reports',
        headers: { cookie: org.cookie },
      });
      const orgView = orgRepList.json().reports.find((r: any) => r.id === reportId);
      expect(orgView.reporter.username).toBe('ANONYMOUS_REPORTER');

      const admRepList = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/admin/reports',
        headers: { cookie: admin.cookie },
      });
      const admView = admRepList.json().reports.find((r: any) => r.id === reportId);
      expect(admView.reporter.username).toBe(p2.username);

      // Concurrent report resolution -> exactly 1 succeeds
      const [mr1, mr2] = await Promise.all([
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/reports/${reportId}`,
          headers: { cookie: mod.cookie, 'x-csrf-token': mod.csrf },
          payload: {
            status: 'RESOLVED',
            assignedModeratorId: mod.userId,
            internalNotes: 'Verified logs',
            resolution: 'Warning issued to participant',
          },
        }),
        ctx.app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/reports/${reportId}`,
          headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
          payload: {
            status: 'DISMISSED',
            resolution: 'Duplicate closure attempt',
          },
        }),
      ]);
      expect([mr1.statusCode, mr2.statusCode].sort()[0]).toBe(200);
      expect([mr1.statusCode, mr2.statusCode].sort()[1]).toBeGreaterThanOrEqual(400);

      await prisma.competition.delete({ where: { id: comp.id } });
    } finally {
      await ctx.app.close();
    }
  });
});
