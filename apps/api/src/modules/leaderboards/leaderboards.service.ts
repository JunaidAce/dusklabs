import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';
import type { RankedEntry, ScoringService } from '../scoring/scoring.service.js';

export class LeaderboardsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly scoringService: ScoringService,
  ) {}

  private isStaffForCompetition(
    auth: AuthenticatedContext | null,
    createdById: string,
  ): boolean {
    if (!auth) return false;
    if (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    ) {
      return true;
    }
    return auth.roles.includes('COMPETITION_ORGANIZER') && createdById === auth.userId;
  }

  private async resolveCurrentUserEntityId(
    viewerUserId: string | undefined,
    entityType: 'INDIVIDUAL' | 'TEAM',
    competitionId?: string,
  ): Promise<string | null> {
    if (!viewerUserId) return null;
    if (entityType === 'INDIVIDUAL') return viewerUserId;

    if (competitionId) {
      const tm = await this.prisma.teamMember.findFirst({
        where: {
          userId: viewerUserId,
          team: {
            deletedAt: null,
            competitions: { some: { competitionId, status: 'CONFIRMED' } },
          },
        },
        select: { teamId: true },
      });
      return tm?.teamId ?? null;
    }

    const tm = await this.prisma.teamMember.findFirst({
      where: { userId: viewerUserId, team: { deletedAt: null } },
      orderBy: { joinedAt: 'desc' },
      select: { teamId: true },
    });
    return tm?.teamId ?? null;
  }

  private async getRecentPublishedSolves(competitionId?: string, limit = 15) {
    const solves = await this.prisma.solve.findMany({
      where: {
        ...(competitionId ? { competitionId } : {}),
        challenge: { status: 'PUBLISHED', isVisible: true },
      },
      orderBy: { solvedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        pointsAwarded: true,
        isFirstBlood: true,
        solvedAt: true,
        user: { select: { username: true, displayName: true } },
        team: { select: { name: true, slug: true } },
        challenge: { select: { slug: true, title: true } },
        competition: { select: { slug: true, title: true } },
      },
    });

    return solves;
  }

  async getCategoryStats(competitionId?: string) {
    const [categories, challengeLinks, publishedSolves] = await Promise.all([
      this.prisma.category.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, slug: true, name: true },
      }),
      this.prisma.challengeCategory.findMany({
        where: {
          challenge: {
            status: 'PUBLISHED',
            isVisible: true,
            ...(competitionId ? { competitionId } : {}),
          },
        },
        select: { categoryId: true, challengeId: true },
      }),
      this.prisma.solve.findMany({
        where: {
          ...(competitionId ? { competitionId } : {}),
          challenge: { status: 'PUBLISHED', isVisible: true },
        },
        select: { challengeId: true, isFirstBlood: true },
      }),
    ]);

    const solvesPerChallenge = new Map<string, number>();
    const fbPerChallenge = new Map<string, number>();
    for (const s of publishedSolves) {
      solvesPerChallenge.set(s.challengeId, (solvesPerChallenge.get(s.challengeId) ?? 0) + 1);
      if (s.isFirstBlood) {
        fbPerChallenge.set(s.challengeId, (fbPerChallenge.get(s.challengeId) ?? 0) + 1);
      }
    }

    const challengeIdsByCat = new Map<string, Set<string>>();
    for (const link of challengeLinks) {
      const set = challengeIdsByCat.get(link.categoryId) ?? new Set<string>();
      set.add(link.challengeId);
      challengeIdsByCat.set(link.categoryId, set);
    }

    return {
      categories: categories.map((cat) => {
        const chalIds = challengeIdsByCat.get(cat.id) ?? new Set<string>();
        let totalSolves = 0;
        let firstBloodCount = 0;
        for (const cid of chalIds) {
          totalSolves += solvesPerChallenge.get(cid) ?? 0;
          firstBloodCount += fbPerChallenge.get(cid) ?? 0;
        }
        return {
          id: cat.id,
          slug: cat.slug,
          name: cat.name,
          publishedChallengeCount: chalIds.size,
          totalSolves,
          firstBloodCount,
        };
      }),
    };
  }

  async getGlobalLeaderboard(params: {
    entityType: 'INDIVIDUAL' | 'TEAM';
    page: number;
    limit: number;
    viewerUserId?: string;
  }) {
    const allRanked = await this.scoringService.computeStandings({
      entityType: params.entityType,
      allowNegative: false,
    });

    const total = allRanked.length;
    const totalPages = Math.max(1, Math.ceil(total / params.limit));
    const offset = (params.page - 1) * params.limit;
    const entries = allRanked.slice(offset, offset + params.limit);

    const currentEntityId = await this.resolveCurrentUserEntityId(
      params.viewerUserId,
      params.entityType,
    );
    const currentUserEntry: RankedEntry | null = currentEntityId
      ? allRanked.find((e) => e.entityId === currentEntityId) ?? null
      : null;

    const [recentSolves, categoryStats] = await Promise.all([
      this.getRecentPublishedSolves(undefined, 12),
      this.getCategoryStats(undefined),
    ]);

    return {
      scope: 'GLOBAL' as const,
      entityType: params.entityType,
      entries,
      currentUserEntry,
      recentSolves,
      categoryStats: categoryStats.categories,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages,
      },
    };
  }

  async getCompetitionLeaderboard(params: {
    slug: string;
    entityType: 'INDIVIDUAL' | 'TEAM';
    page: number;
    limit: number;
    auth: AuthenticatedContext | null;
  }) {
    const comp = await this.prisma.competition.findUnique({
      where: { slug: params.slug },
      select: {
        id: true,
        slug: true,
        title: true,
        status: true,
        participationMode: true,
        scoringMode: true,
        allowNegativeScores: true,
        createdById: true,
        startsAt: true,
        endsAt: true,
      },
    });

    if (!comp) {
      throw new NotFoundError('Competition not found');
    }

    if (comp.status === 'DRAFT' && !this.isStaffForCompetition(params.auth, comp.createdById)) {
      throw new NotFoundError('Competition not found');
    }

    const allRanked = await this.scoringService.computeStandings({
      competitionId: comp.id,
      entityType: params.entityType,
      allowNegative: comp.allowNegativeScores,
    });

    const total = allRanked.length;
    const totalPages = Math.max(1, Math.ceil(total / params.limit));
    const offset = (params.page - 1) * params.limit;
    const entries = allRanked.slice(offset, offset + params.limit);

    const currentEntityId = await this.resolveCurrentUserEntityId(
      params.auth?.userId,
      params.entityType,
      comp.id,
    );
    const currentUserEntry: RankedEntry | null = currentEntityId
      ? allRanked.find((e) => e.entityId === currentEntityId) ?? null
      : null;

    const [recentSolves, categoryStats] = await Promise.all([
      this.getRecentPublishedSolves(comp.id, 12),
      this.getCategoryStats(comp.id),
    ]);

    return {
      scope: 'COMPETITION' as const,
      competition: {
        id: comp.id,
        slug: comp.slug,
        title: comp.title,
        status: comp.status,
        participationMode: comp.participationMode,
        scoringMode: comp.scoringMode,
        startsAt: comp.startsAt,
        endsAt: comp.endsAt,
      },
      entityType: params.entityType,
      entries,
      currentUserEntry,
      recentSolves,
      categoryStats: categoryStats.categories,
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages,
      },
    };
  }
}
