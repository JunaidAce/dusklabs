import type { ReportCategory, ReportStatus, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';

const VALID_REPORT_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
  UNDER_REVIEW: ['RESOLVED', 'DISMISSED', 'OPEN'],
  RESOLVED: [],
  DISMISSED: [],
};

export class ModerationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private isGlobalModerator(auth: AuthenticatedContext): boolean {
    return this.isPlatformAdmin(auth) || auth.roles.includes('MODERATOR' satisfies RoleName);
  }

  private async getOrganizerCompetitionIds(userId: string): Promise<string[]> {
    const comps = await this.prisma.competition.findMany({
      where: {
        OR: [{ createdById: userId }, { organizers: { some: { userId } } }],
      },
      select: { id: true },
    });
    return comps.map((c) => c.id);
  }

  // -------------------- SUBMISSION INSPECTOR --------------------

  async listSubmissions(
    auth: AuthenticatedContext,
    query: {
      search?: string;
      isCorrect?: boolean;
      challengeId?: string;
      competitionId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const isGlobal = this.isGlobalModerator(auth);

    let scopedCompIds: string[] | null = null;
    if (!isGlobal) {
      scopedCompIds = await this.getOrganizerCompetitionIds(auth.userId);
      if (scopedCompIds.length === 0) {
        return { submissions: [], pagination: { page, limit, total: 0, totalPages: 1 } };
      }
      if (query.competitionId && !scopedCompIds.includes(query.competitionId)) {
        throw new ForbiddenError('Not authorized to inspect submissions for this competition');
      }
    }

    const search = query.search?.trim();
    const where: any = {
      ...(query.isCorrect !== undefined ? { isCorrect: query.isCorrect } : {}),
      ...(query.challengeId ? { challengeId: query.challengeId } : {}),
      ...(query.competitionId
        ? { competitionId: query.competitionId }
        : scopedCompIds
          ? { competitionId: { in: scopedCompIds } }
          : {}),
      ...(search
        ? {
            OR: [
              { id: search },
              { user: { username: { contains: search } } },
              { challenge: { title: { contains: search } } },
              { challenge: { slug: { contains: search } } },
              { competition: { title: { contains: search } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.submission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          isCorrect: true,
          ipAddress: true,
          submittedAt: true,
          user: { select: { id: true, username: true, displayName: true, accountStatus: true } },
          team: { select: { id: true, name: true, slug: true } },
          challenge: { select: { id: true, slug: true, title: true, points: true } },
          competition: { select: { id: true, slug: true, title: true } },
          _count: { select: { disputeCorrections: true } },
        },
      }),
      this.prisma.submission.count({ where }),
    ]);

    // Compute per-user failure burst indicator on the returned batch
    const userIds = Array.from(new Set(rows.map((r) => r.user.id)));
    const recentIncorrectCounts = new Map<string, number>();
    if (userIds.length > 0) {
      const windowStart = new Date(Date.now() - 15 * 60 * 1000);
      const recentFails = await this.prisma.submission.groupBy({
        by: ['userId'],
        where: {
          userId: { in: userIds },
          isCorrect: false,
          submittedAt: { gte: windowStart },
        },
        _count: { _all: true },
      });
      for (const rf of recentFails) {
        recentIncorrectCounts.set(rf.userId, rf._count._all);
      }
    }

    return {
      submissions: rows.map((r) => ({
        id: r.id,
        isCorrect: r.isCorrect,
        ipAddress: isGlobal ? r.ipAddress : null,
        submittedAt: r.submittedAt,
        user: r.user,
        team: r.team,
        challenge: r.challenge,
        competition: r.competition,
        disputeCorrectionCount: r._count.disputeCorrections,
        suspiciousIndicator:
          (recentIncorrectCounts.get(r.user.id) ?? 0) >= 5 ? 'HIGH_FAILURE_RATE' : null,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getSubmissionDetail(auth: AuthenticatedContext, submissionId: string) {
    const sub = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        isCorrect: true,
        ipAddress: true,
        submittedAt: true,
        challengeId: true,
        competitionId: true,
        userId: true,
        teamId: true,
        user: { select: { id: true, username: true, displayName: true, accountStatus: true } },
        team: { select: { id: true, name: true, slug: true } },
        challenge: { select: { id: true, slug: true, title: true, points: true } },
        competition: { select: { id: true, slug: true, title: true } },
        disputeCorrections: {
          orderBy: { createdAt: 'desc' },
          include: { admin: { select: { id: true, username: true } } },
        },
      },
    });
    if (!sub) throw new NotFoundError('Submission not found');

    const isGlobal = this.isGlobalModerator(auth);
    if (!isGlobal) {
      const compIds = await this.getOrganizerCompetitionIds(auth.userId);
      if (!sub.competitionId || !compIds.includes(sub.competitionId)) {
        throw new ForbiddenError('Not authorized to view this submission');
      }
    }

    const existingSolve = await this.prisma.solve.findFirst({
      where: {
        challengeId: sub.challengeId,
        ...(sub.teamId ? { OR: [{ userId: sub.userId }, { teamId: sub.teamId }] } : { userId: sub.userId }),
      },
      select: { id: true, pointsAwarded: true, isFirstBlood: true, solvedAt: true },
    });

    return {
      submission: {
        ...sub,
        ipAddress: isGlobal ? sub.ipAddress : null,
      },
      existingSolve,
    };
  }

  async resolveSubmissionDispute(
    auth: AuthenticatedContext,
    submissionId: string,
    input: {
      action: 'CREDIT_POINTS' | 'REVOKE_POINTS' | 'UPHOLD_ORIGINAL';
      deltaPoints?: number;
      reason: string;
    },
    ipAddress?: string,
  ) {
    const sub = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { challenge: { select: { slug: true } } },
    });
    if (!sub) throw new NotFoundError('Submission not found');

    if (!this.isPlatformAdmin(auth)) {
      const compIds = await this.getOrganizerCompetitionIds(auth.userId);
      if (!sub.competitionId || !compIds.includes(sub.competitionId)) {
        throw new ForbiddenError('Not authorized to resolve disputes for this competition');
      }
    }

    const previousState = sub.isCorrect ? 'CORRECT_SUBMISSION' : 'INCORRECT_SUBMISSION';
    const signedDelta =
      input.action === 'CREDIT_POINTS'
        ? (input.deltaPoints ?? 0)
        : input.action === 'REVOKE_POINTS'
          ? -(input.deltaPoints ?? 0)
          : 0;

    const resultingState =
      input.action === 'CREDIT_POINTS'
        ? `DISPUTE_CREDITED (+${signedDelta} PTS)`
        : input.action === 'REVOKE_POINTS'
          ? `DISPUTE_REVOKED (${signedDelta} PTS)`
          : 'ORIGINAL_SUBMISSION_UPHELD';

    // Preserve original Submission & Solve evidence; append immutable ledger & correction records
    const result = await this.prisma.$transaction(async (tx) => {
      let txId: string | null = null;
      if (signedDelta !== 0) {
        const scoreTx = await tx.scoreTransaction.create({
          data: {
            userId: sub.userId,
            teamId: sub.teamId,
            competitionId: sub.competitionId,
            deltaPoints: signedDelta,
            type: 'MANUAL_ADJUSTMENT',
            reason: `Dispute resolution on submission ${sub.id} (${sub.challenge.slug}): ${input.reason}`,
            actorId: auth.userId,
          },
        });
        txId = scoreTx.id;
      }

      const correction = await tx.submissionDisputeCorrection.create({
        data: {
          submissionId: sub.id,
          action: input.action,
          previousState,
          resultingState,
          deltaPoints: signedDelta,
          reason: input.reason,
          scoreTransactionId: txId,
          adminId: auth.userId,
        },
      });

      return correction;
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'SUBMISSION_DISPUTE_RESOLVED',
      entityType: 'Submission',
      entityId: sub.id,
      metadata: {
        correctionId: result.id,
        action: input.action,
        previousState,
        resultingState,
        deltaPoints: signedDelta,
        reason: input.reason,
      },
      ipAddress,
    });

    return { correction: result };
  }

  // -------------------- SUSPICIOUS ACTIVITY REVIEW --------------------

  async getSuspiciousActivitySummary(auth: AuthenticatedContext) {
    if (!this.isGlobalModerator(auth)) {
      throw new ForbiddenError('Global moderation permissions required');
    }

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [recentSubs, openTargetReports] = await Promise.all([
      this.prisma.submission.findMany({
        where: { submittedAt: { gte: since24h } },
        orderBy: { submittedAt: 'asc' },
        select: {
          userId: true,
          challengeId: true,
          isCorrect: true,
          submittedAt: true,
          user: { select: { id: true, username: true, accountStatus: true } },
        },
      }),
      this.prisma.report.groupBy({
        by: ['targetUserId'],
        where: {
          targetUserId: { not: null },
          status: { in: ['OPEN', 'UNDER_REVIEW'] },
          category: { in: ['CHEATING', 'ABUSE'] },
        },
        _count: { _all: true },
      }),
    ]);

    const statsByUser = new Map<
      string,
      {
        username: string;
        accountStatus: string;
        incorrectCount24h: number;
        totalCount24h: number;
        timestamps: number[];
        challengeFails: Map<string, number>;
        openAbuseReports: number;
      }
    >();

    for (const s of recentSubs) {
      const entry = statsByUser.get(s.userId) ?? {
        username: s.user.username,
        accountStatus: s.user.accountStatus,
        incorrectCount24h: 0,
        totalCount24h: 0,
        timestamps: [] as number[],
        challengeFails: new Map<string, number>(),
        openAbuseReports: 0,
      };
      entry.totalCount24h++;
      entry.timestamps.push(s.submittedAt.getTime());
      if (!s.isCorrect) {
        entry.incorrectCount24h++;
        entry.challengeFails.set(
          s.challengeId,
          (entry.challengeFails.get(s.challengeId) ?? 0) + 1,
        );
      }
      statsByUser.set(s.userId, entry);
    }

    for (const rep of openTargetReports) {
      if (!rep.targetUserId) continue;
      const existing = statsByUser.get(rep.targetUserId);
      if (existing) {
        existing.openAbuseReports = rep._count._all;
      } else {
        const u = await this.prisma.user.findUnique({
          where: { id: rep.targetUserId },
          select: { username: true, accountStatus: true },
        });
        if (u) {
          statsByUser.set(rep.targetUserId, {
            username: u.username,
            accountStatus: u.accountStatus,
            incorrectCount24h: 0,
            totalCount24h: 0,
            timestamps: [],
            challengeFails: new Map(),
            openAbuseReports: rep._count._all,
          });
        }
      }
    }

    const alerts: Array<{
      userId: string;
      username: string;
      accountStatus: string;
      incorrectCount24h: number;
      maxSubmissionsPerMinute: number;
      openAbuseReports: number;
      reasons: string[];
    }> = [];

    for (const [userId, st] of statsByUser.entries()) {
      // Sliding 60-second burst count
      let maxBurst = 0;
      let left = 0;
      for (let right = 0; right < st.timestamps.length; right++) {
        while (st.timestamps[right]! - st.timestamps[left]! > 60_000) {
          left++;
        }
        maxBurst = Math.max(maxBurst, right - left + 1);
      }

      const maxSingleChallengeFails = Math.max(0, ...st.challengeFails.values());
      const reasons: string[] = [];

      if (st.incorrectCount24h >= 15 || maxSingleChallengeFails >= 8) {
        reasons.push('EXCESSIVE_INCORRECT_ATTEMPTS');
      }
      if (maxBurst >= 5) {
        reasons.push('RAPID_SUBMISSION_BURST');
      }
      if (st.openAbuseReports >= 2) {
        reasons.push('REPEATED_ABUSE_REPORTS');
      }

      if (reasons.length > 0) {
        alerts.push({
          userId,
          username: st.username,
          accountStatus: st.accountStatus,
          incorrectCount24h: st.incorrectCount24h,
          maxSubmissionsPerMinute: maxBurst,
          openAbuseReports: st.openAbuseReports,
          reasons,
        });
      }
    }

    return { alerts };
  }

  // -------------------- ABUSE & BUG REPORTS --------------------

  async submitReport(
    reporterId: string,
    input: {
      competitionId?: string;
      challengeId?: string;
      targetUserId?: string;
      submissionId?: string;
      category: ReportCategory;
      description: string;
      isAnonymous: boolean;
    },
    ipAddress?: string,
  ) {
    const report = await this.prisma.report.create({
      data: {
        reporterId,
        competitionId: input.competitionId ?? null,
        challengeId: input.challengeId ?? null,
        targetUserId: input.targetUserId ?? null,
        submissionId: input.submissionId ?? null,
        category: input.category,
        description: input.description,
        isAnonymous: input.isAnonymous,
      },
      select: {
        id: true,
        category: true,
        status: true,
        isAnonymous: true,
        createdAt: true,
      },
    });

    await this.audit.record({
      actorId: reporterId,
      action: 'MODERATION_REPORT_SUBMITTED',
      entityType: 'Report',
      entityId: report.id,
      metadata: { category: report.category, isAnonymous: report.isAnonymous },
      ipAddress,
    });

    return { report };
  }

  async listMyReports(reporterId: string) {
    const reports = await this.prisma.report.findMany({
      where: { reporterId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        category: true,
        description: true,
        status: true,
        resolution: true,
        isAnonymous: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    return { reports };
  }

  private redactReporterIfPrivate(
    auth: AuthenticatedContext,
    report: { isAnonymous: boolean; reporter: { id: string; username: string } },
  ) {
    if (!report.isAnonymous || this.isPlatformAdmin(auth)) {
      return report.reporter;
    }
    return { id: null, username: 'ANONYMOUS_REPORTER' };
  }

  async listReportsAdmin(
    auth: AuthenticatedContext,
    query: {
      status?: ReportStatus;
      category?: ReportCategory;
      assignedToMe?: boolean;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const isGlobal = this.isGlobalModerator(auth);

    let scopedCompIds: string[] | null = null;
    if (!isGlobal) {
      scopedCompIds = await this.getOrganizerCompetitionIds(auth.userId);
      if (scopedCompIds.length === 0) {
        return { reports: [], pagination: { page, limit, total: 0, totalPages: 1 } };
      }
    }

    const where: any = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedToMe ? { assignedModeratorId: auth.userId } : {}),
      ...(scopedCompIds ? { competitionId: { in: scopedCompIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          reporter: { select: { id: true, username: true } },
          targetUser: { select: { id: true, username: true } },
          assignedModerator: { select: { id: true, username: true } },
          resolvedBy: { select: { id: true, username: true } },
          challenge: { select: { id: true, slug: true, title: true } },
          competition: { select: { id: true, slug: true, title: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return {
      reports: rows.map((r) => ({
        id: r.id,
        category: r.category,
        description: r.description,
        isAnonymous: r.isAnonymous,
        status: r.status,
        submissionId: r.submissionId,
        internalNotes: r.internalNotes,
        resolution: r.resolution,
        reporter: this.redactReporterIfPrivate(auth, r),
        targetUser: r.targetUser,
        assignedModerator: r.assignedModerator,
        resolvedBy: r.resolvedBy,
        challenge: r.challenge,
        competition: r.competition,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async moderateReport(
    auth: AuthenticatedContext,
    reportId: string,
    input: {
      status?: ReportStatus;
      assignedModeratorId?: string | null;
      internalNotes?: string | null;
      resolution?: string;
    },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!existing) throw new NotFoundError('Report not found');

    if (!this.isGlobalModerator(auth)) {
      const compIds = await this.getOrganizerCompetitionIds(auth.userId);
      if (!existing.competitionId || !compIds.includes(existing.competitionId)) {
        throw new ForbiddenError('Not authorized to moderate this report');
      }
    }

    if (input.status && input.status !== existing.status) {
      const allowed = VALID_REPORT_TRANSITIONS[existing.status as ReportStatus] ?? [];
      if (!allowed.includes(input.status)) {
        throw new BadRequestError(
          `Invalid report transition: ${existing.status} -> ${input.status}`,
          'INVALID_TRANSITION',
        );
      }
      if ((input.status === 'RESOLVED' || input.status === 'DISMISSED') && !input.resolution) {
        throw new BadRequestError('A resolution reason is required when closing a report');
      }
    }

    if (input.assignedModeratorId) {
      const mod = await this.prisma.user.findUnique({
        where: { id: input.assignedModeratorId },
        include: { roles: { include: { role: true } } },
      });
      const modAllowed = new Set(['SUPER_ADMIN', 'PLATFORM_ADMIN', 'MODERATOR', 'COMPETITION_ORGANIZER']);
      if (!mod || !mod.roles.some((r) => modAllowed.has(r.role.name))) {
        throw new BadRequestError('Assigned moderator must hold an authorized moderation role');
      }
    }

    const isTerminal = input.status === 'RESOLVED' || input.status === 'DISMISSED';

    const cas = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status, version: existing.version },
      data: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.assignedModeratorId !== undefined
          ? { assignedModeratorId: input.assignedModeratorId }
          : {}),
        ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
        ...(isTerminal ? { resolvedById: auth.userId, resolvedAt: new Date() } : {}),
        version: { increment: 1 },
      },
    });

    if (cas.count !== 1) {
      throw new ConflictError('Report was modified concurrently; refresh and retry', 'CONCURRENT_MODIFICATION');
    }

    const updated = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    await this.audit.record({
      actorId: auth.userId,
      action: 'MODERATION_REPORT_UPDATED',
      entityType: 'Report',
      entityId: reportId,
      metadata: {
        previousStatus: existing.status,
        newStatus: updated.status,
        assignedModeratorId: updated.assignedModeratorId,
        reason: input.resolution ?? null,
      },
      ipAddress,
    });

    return { report: updated };
  }
}
