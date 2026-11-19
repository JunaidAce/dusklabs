import type { PrismaClient } from '@prisma/client';

function parseAuditMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class AdminOverviewService {
  constructor(private readonly prisma: PrismaClient) {}

  async getDashboardOverview() {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      bannedUsers,
      totalTeams,
      totalCompetitions,
      liveCompetitions,
      totalChallenges,
      publishedChallenges,
      totalSubmissions,
      validSubmissions,
      failedSubmissions,
      openReports,
      underReviewReports,
      openContactInquiries,
      recentSolves,
      recentRegistrations,
      recentAuditLogs,
      recentModerationReports,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, accountStatus: 'ACTIVE' } }),
      this.prisma.user.count({ where: { deletedAt: null, accountStatus: 'SUSPENDED' } }),
      this.prisma.user.count({ where: { deletedAt: null, accountStatus: 'BANNED' } }),
      this.prisma.team.count({ where: { deletedAt: null } }),
      this.prisma.competition.count(),
      this.prisma.competition.count({ where: { status: 'LIVE' } }),
      this.prisma.challenge.count(),
      this.prisma.challenge.count({ where: { status: 'PUBLISHED', isVisible: true } }),
      this.prisma.submission.count(),
      this.prisma.submission.count({ where: { isCorrect: true } }),
      this.prisma.submission.count({ where: { isCorrect: false } }),
      this.prisma.report.count({ where: { status: 'OPEN' } }),
      this.prisma.report.count({ where: { status: 'UNDER_REVIEW' } }),
      this.prisma.contactInquiry.count({ where: { status: { in: ['OPEN', 'IN_REVIEW'] } } }),
      this.prisma.solve.findMany({
        orderBy: { solvedAt: 'desc' },
        take: 8,
        select: {
          id: true,
          pointsAwarded: true,
          isFirstBlood: true,
          solvedAt: true,
          user: { select: { id: true, username: true } },
          team: { select: { id: true, name: true } },
          challenge: { select: { slug: true, title: true } },
          competition: { select: { slug: true, title: true } },
        },
      }),
      this.prisma.competitionRegistration.findMany({
        orderBy: { registeredAt: 'desc' },
        take: 5,
        select: {
          id: true,
          status: true,
          registeredAt: true,
          user: { select: { id: true, username: true } },
          competition: { select: { slug: true, title: true } },
        },
      }),
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          action: true,
          entityType: true,
          entityId: true,
          metadata: true,
          createdAt: true,
          actor: { select: { id: true, username: true } },
        },
      }),
      this.prisma.report.findMany({
        where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          category: true,
          status: true,
          createdAt: true,
          reporter: { select: { id: true, username: true } },
          challenge: { select: { slug: true, title: true } },
          competition: { select: { slug: true, title: true } },
        },
      }),
    ]);

    return {
      metrics: {
        users: {
          total: totalUsers,
          active: activeUsers,
          suspended: suspendedUsers,
          banned: bannedUsers,
        },
        teams: {
          total: totalTeams,
        },
        competitions: {
          total: totalCompetitions,
          live: liveCompetitions,
        },
        challenges: {
          total: totalChallenges,
          published: publishedChallenges,
        },
        submissions: {
          total: totalSubmissions,
          valid: validSubmissions,
          failed: failedSubmissions,
        },
        moderation: {
          openReports,
          underReviewReports,
          openContactInquiries,
          totalPendingQueue: openReports + underReviewReports + openContactInquiries,
        },
      },
      recentActivity: {
        solves: recentSolves,
        registrations: recentRegistrations,
      },
      recentAuditEvents: recentAuditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        actor: log.actor,
        metadata: parseAuditMetadata(log.metadata),
        createdAt: log.createdAt,
      })),
      moderationQueuePreview: recentModerationReports,
    };
  }
}
