import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
  },
) {
  // Public telemetry for landing page (strictly non-sensitive counts & published records)
  app.get('/api/v1/public/overview', async () => {
    const [
      totalUsers,
      totalTeams,
      publishedChallengesCount,
      upcomingCompetitions,
      featuredChallenges,
    ] = await Promise.all([
      deps.prisma.user.count({ where: { accountStatus: 'ACTIVE', deletedAt: null } }),
      deps.prisma.team.count({ where: { deletedAt: null } }),
      deps.prisma.challenge.count({ where: { status: 'PUBLISHED', isVisible: true } }),
      deps.prisma.competition.findMany({
        where: { status: { in: ['SCHEDULED', 'REGISTRATION_OPEN', 'UPCOMING', 'LIVE'] } },
        orderBy: { startsAt: 'asc' },
        take: 3,
        select: {
          id: true,
          slug: true,
          title: true,
          status: true,
          participationMode: true,
          scoringMode: true,
          startsAt: true,
          endsAt: true,
        },
      }),
      deps.prisma.challenge.findMany({
        where: { status: 'PUBLISHED', isVisible: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: {
          id: true,
          slug: true,
          title: true,
          difficulty: true,
          points: true,
          categories: {
            select: { category: { select: { name: true, slug: true } } },
          },
        },
      }),
    ]);

    return {
      stats: {
        activeParticipants: totalUsers,
        registeredTeams: totalTeams,
        publishedChallenges: publishedChallengesCount,
        openCompetitions: upcomingCompetitions.length,
      },
      upcomingCompetitions,
      featuredChallenges: featuredChallenges.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        difficulty: c.difficulty,
        points: c.points,
        categories: c.categories.map((cc) => cc.category.name),
      })),
    };
  });

  // Authenticated user dashboard summary (zero fake data)
  app.get(
    '/api/v1/dashboard/summary',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => {
      const userId = request.auth!.userId;

      const [scoreAgg, solvedCount, registrations, teamMembership, recentSolves, recentNotifications] =
        await Promise.all([
          deps.prisma.scoreTransaction.aggregate({
            where: { userId },
            _sum: { deltaPoints: true },
          }),
          deps.prisma.solve.count({ where: { userId } }),
          deps.prisma.competitionRegistration.findMany({
            where: { userId, status: 'CONFIRMED' },
            include: {
              competition: {
                select: { id: true, slug: true, title: true, status: true, startsAt: true, endsAt: true },
              },
            },
            orderBy: { registeredAt: 'desc' },
            take: 5,
          }),
          deps.prisma.teamMember.findFirst({
            where: { userId },
            include: {
              team: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  _count: { select: { members: true } },
                },
              },
            },
          }),
          deps.prisma.solve.findMany({
            where: { userId },
            orderBy: { solvedAt: 'desc' },
            take: 5,
            include: {
              challenge: { select: { slug: true, title: true } },
            },
          }),
          deps.prisma.notification.count({
            where: { userId, isRead: false },
          }),
        ]);

      return {
        totalPoints: scoreAgg._sum.deltaPoints ?? 0,
        solvedChallenges: solvedCount,
        unreadNotifications: recentNotifications,
        team: teamMembership
          ? {
              id: teamMembership.team.id,
              name: teamMembership.team.name,
              slug: teamMembership.team.slug,
              role: teamMembership.role,
              memberCount: teamMembership.team._count.members,
            }
          : null,
        registeredCompetitions: registrations.map((r) => r.competition),
        recentActivity: recentSolves.map((s) => ({
          id: s.id,
          challengeSlug: s.challenge.slug,
          challengeTitle: s.challenge.title,
          pointsAwarded: s.pointsAwarded,
          isFirstBlood: s.isFirstBlood,
          solvedAt: s.solvedAt,
        })),
      };
    },
  );
}
