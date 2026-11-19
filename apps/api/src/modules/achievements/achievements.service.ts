import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { ConflictError, NotFoundError } from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { ScoringService } from '../scoring/scoring.service.js';

export class AchievementsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly scoringService: ScoringService,
  ) {}

  private isAdmin(auth: AuthenticatedContext | null): boolean {
    if (!auth) return false;
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async grantAward(params: {
    userId: string;
    achievement: {
      id: string;
      code: string;
      name: string;
      description: string;
      tier: string;
      iconKey: string;
    };
    awardScopeKey: string;
    competitionId?: string | null;
    teamId?: string | null;
    challengeId?: string | null;
  }): Promise<boolean> {
    try {
      await this.prisma.userAchievement.create({
        data: {
          userId: params.userId,
          achievementId: params.achievement.id,
          competitionId: params.competitionId ?? null,
          teamId: params.teamId ?? null,
          challengeId: params.challengeId ?? null,
          awardScopeKey: params.awardScopeKey,
          awardedName: params.achievement.name,
          awardedDescription: params.achievement.description,
          awardedTier: params.achievement.tier,
          awardedIcon: params.achievement.iconKey,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002' || String(err?.message ?? '').includes('UNIQUE constraint')) {
        return false; // Already awarded — zero duplicates
      }
      throw err;
    }

    await this.notifications.dispatchToUsers({
      userIds: [params.userId],
      type: 'ACHIEVEMENT',
      title: `Achievement Unlocked: ${params.achievement.name}`,
      message: params.achievement.description,
      linkUrl: '/achievements',
      dedupeKey: `ach:${params.achievement.id}:${params.awardScopeKey}`,
    });

    return true;
  }

  async evaluateAfterSolve(params: {
    userId: string;
    teamId: string | null;
    challengeId: string;
    competitionId: string | null;
    isFirstBlood: boolean;
  }): Promise<void> {
    const activeDefs = await this.prisma.achievement.findMany({
      where: { isActive: true },
    });
    if (activeDefs.length === 0) return;

    const [totalSolves, challengeWithCats] = await Promise.all([
      this.prisma.solve.count({ where: { userId: params.userId } }),
      this.prisma.challenge.findUnique({
        where: { id: params.challengeId },
        select: {
          categories: { select: { category: { select: { slug: true } } } },
        },
      }),
    ]);

    const solvedCategorySlugs = new Set(
      challengeWithCats?.categories.map((c) => c.category.slug) ?? [],
    );

    const categorySolveCounts = new Map<string, number>();
    for (const slug of solvedCategorySlugs) {
      const count = await this.prisma.solve.count({
        where: {
          userId: params.userId,
          challenge: { categories: { some: { category: { slug } } } },
        },
      });
      categorySolveCounts.set(slug, count);
    }

    for (const def of activeDefs) {
      if (def.ruleType === 'FIRST_BLOOD' && params.isFirstBlood) {
        await this.grantAward({
          userId: params.userId,
          achievement: def,
          awardScopeKey: 'GLOBAL',
          competitionId: params.competitionId,
          teamId: params.teamId,
          challengeId: params.challengeId,
        });
      } else if (def.ruleType === 'TOTAL_SOLVES' && totalSolves >= def.threshold) {
        await this.grantAward({
          userId: params.userId,
          achievement: def,
          awardScopeKey: 'GLOBAL',
          competitionId: params.competitionId,
          teamId: params.teamId,
          challengeId: params.challengeId,
        });
      } else if (def.ruleType.startsWith('CATEGORY_SOLVES:')) {
        const slug = def.ruleType.slice('CATEGORY_SOLVES:'.length);
        const count = categorySolveCounts.get(slug) ?? 0;
        if (count >= def.threshold) {
          await this.grantAward({
            userId: params.userId,
            achievement: def,
            awardScopeKey: 'GLOBAL',
            competitionId: params.competitionId,
            teamId: params.teamId,
            challengeId: params.challengeId,
          });
        }
      } else if (def.ruleType === 'COMPETITION_PARTICIPATION' && params.competitionId) {
        await this.grantAward({
          userId: params.userId,
          achievement: def,
          awardScopeKey: params.competitionId,
          competitionId: params.competitionId,
          teamId: params.teamId,
          challengeId: params.challengeId,
        });
      }
    }
  }

  /**
   * Evaluates Competition Participant & Competition Champion strictly from finalized COMPLETED standings.
   */
  async evaluateOnCompetitionCompleted(competitionId: string): Promise<void> {
    const comp = await this.prisma.competition.findUnique({
      where: { id: competitionId },
    });
    if (!comp || comp.status !== 'COMPLETED') return;

    const [participantDef, championDef, confirmedRegs] = await Promise.all([
      this.prisma.achievement.findFirst({
        where: { ruleType: 'COMPETITION_PARTICIPATION', isActive: true },
      }),
      this.prisma.achievement.findFirst({
        where: { ruleType: 'COMPETITION_CHAMPION', isActive: true },
      }),
      this.prisma.competitionRegistration.findMany({
        where: { competitionId, status: 'CONFIRMED' },
        select: { userId: true, teamId: true },
      }),
    ]);

    if (participantDef) {
      for (const reg of confirmedRegs) {
        await this.grantAward({
          userId: reg.userId,
          achievement: participantDef,
          awardScopeKey: competitionId,
          competitionId,
          teamId: reg.teamId,
        });
      }
    }

    if (!championDef) return;

    const entityType = comp.participationMode === 'TEAM' ? 'TEAM' : 'INDIVIDUAL';
    const standings = await this.scoringService.computeStandings({
      competitionId,
      entityType,
      allowNegative: comp.allowNegativeScores,
    });

    const winner = standings[0];
    if (!winner || winner.solveCount === 0) return;

    if (entityType === 'INDIVIDUAL') {
      await this.grantAward({
        userId: winner.entityId,
        achievement: championDef,
        awardScopeKey: competitionId,
        competitionId,
      });
    } else {
      const winningMembers = confirmedRegs.filter((r) => r.teamId === winner.entityId);
      for (const member of winningMembers) {
        await this.grantAward({
          userId: member.userId,
          achievement: championDef,
          awardScopeKey: competitionId,
          competitionId,
          teamId: winner.entityId,
        });
      }
    }
  }

  async listAvailableAchievements() {
    const achievements = await this.prisma.achievement.findMany({
      where: { isActive: true },
      orderBy: [{ threshold: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        ruleType: true,
        threshold: true,
        tier: true,
        iconKey: true,
      },
    });
    return { achievements };
  }

  async getMyAchievementsAndProgress(userId: string) {
    const [definitions, awards, totalSolves, firstBloodCount, compCount, categorySolves] =
      await Promise.all([
        this.prisma.achievement.findMany({
          where: { isActive: true },
          orderBy: [{ threshold: 'asc' }, { createdAt: 'asc' }],
        }),
        this.prisma.userAchievement.findMany({
          where: { userId },
          orderBy: { awardedAt: 'desc' },
          include: {
            achievement: { select: { code: true, ruleType: true, threshold: true } },
            competition: { select: { slug: true, title: true } },
          },
        }),
        this.prisma.solve.count({ where: { userId } }),
        this.prisma.solve.count({ where: { userId, isFirstBlood: true } }),
        this.prisma.competitionRegistration.count({
          where: { userId, status: 'CONFIRMED' },
        }),
        this.prisma.solve.findMany({
          where: { userId },
          select: {
            challenge: {
              select: { categories: { select: { category: { select: { slug: true } } } } },
            },
          },
        }),
      ]);

    const catCounts = new Map<string, number>();
    for (const s of categorySolves) {
      for (const c of s.challenge.categories) {
        catCounts.set(c.category.slug, (catCounts.get(c.category.slug) ?? 0) + 1);
      }
    }

    const awardsByAchId = new Map<string, typeof awards>();
    for (const aw of awards) {
      const list = awardsByAchId.get(aw.achievementId) ?? [];
      list.push(aw);
      awardsByAchId.set(aw.achievementId, list);
    }

    const catalog = definitions.map((def) => {
      const earnedList = awardsByAchId.get(def.id) ?? [];
      const earned = earnedList.length > 0;
      let currentProgress = 0;

      if (def.ruleType === 'FIRST_BLOOD') currentProgress = Math.min(def.threshold, firstBloodCount);
      else if (def.ruleType === 'TOTAL_SOLVES') currentProgress = Math.min(def.threshold, totalSolves);
      else if (def.ruleType.startsWith('CATEGORY_SOLVES:')) {
        const slug = def.ruleType.slice('CATEGORY_SOLVES:'.length);
        currentProgress = Math.min(def.threshold, catCounts.get(slug) ?? 0);
      } else if (def.ruleType === 'COMPETITION_PARTICIPATION') {
        currentProgress = earned ? 1 : Math.min(1, compCount);
      } else if (def.ruleType === 'COMPETITION_CHAMPION') {
        currentProgress = earned ? 1 : 0;
      }

      return {
        id: def.id,
        code: def.code,
        name: def.name,
        description: def.description,
        tier: def.tier,
        iconKey: def.iconKey,
        ruleType: def.ruleType,
        threshold: def.threshold,
        currentProgress,
        progressPercent: Math.min(100, Math.round((currentProgress / Math.max(1, def.threshold)) * 100)),
        earned,
        earnedCount: earnedList.length,
        firstAwardedAt: earnedList[earnedList.length - 1]?.awardedAt ?? null,
      };
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { showAchievementsOnProfile: true },
    });

    return {
      showAchievementsOnProfile: user?.showAchievementsOnProfile ?? true,
      catalog,
      history: awards.map((a) => ({
        id: a.id,
        code: a.achievement.code,
        name: a.awardedName,
        description: a.awardedDescription,
        tier: a.awardedTier,
        iconKey: a.awardedIcon,
        competition: a.competition,
        awardedAt: a.awardedAt,
      })),
    };
  }

  async getPublicProfileSummary(username: string, viewer: AuthenticatedContext | null) {
    const user = await this.prisma.user.findFirst({
      where: { username, deletedAt: null, accountStatus: 'ACTIVE' },
      select: {
        id: true,
        username: true,
        displayName: true,
        country: true,
        bio: true,
        createdAt: true,
        showAchievementsOnProfile: true,
      },
    });
    if (!user) throw new NotFoundError('User profile not found');

    const canViewPrivate =
      viewer?.userId === user.id || this.isAdmin(viewer);

    const [scoreAgg, solveCount] = await Promise.all([
      this.prisma.scoreTransaction.aggregate({
        where: { userId: user.id },
        _sum: { deltaPoints: true },
      }),
      this.prisma.solve.count({ where: { userId: user.id } }),
    ]);

    if (!user.showAchievementsOnProfile && !canViewPrivate) {
      return {
        profile: {
          username: user.username,
          displayName: user.displayName,
          country: user.country,
          bio: user.bio,
          joinedAt: user.createdAt,
          totalPoints: Math.max(0, scoreAgg._sum.deltaPoints ?? 0),
          solveCount,
        },
        achievementsHidden: true,
        achievements: [],
      };
    }

    const awards = await this.prisma.userAchievement.findMany({
      where: { userId: user.id },
      orderBy: { awardedAt: 'desc' },
      include: {
        achievement: { select: { code: true } },
        competition: { select: { slug: true, title: true } },
      },
    });

    return {
      profile: {
        username: user.username,
        displayName: user.displayName,
        country: user.country,
        bio: user.bio,
        joinedAt: user.createdAt,
        totalPoints: Math.max(0, scoreAgg._sum.deltaPoints ?? 0),
        solveCount,
      },
      achievementsHidden: false,
      achievements: awards.map((a) => ({
        id: a.id,
        code: a.achievement.code,
        name: a.awardedName,
        description: a.awardedDescription,
        tier: a.awardedTier,
        iconKey: a.awardedIcon,
        competition: a.competition,
        awardedAt: a.awardedAt,
      })),
    };
  }

  async updatePrivacy(userId: string, showAchievementsOnProfile: boolean) {
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { showAchievementsOnProfile },
      select: { showAchievementsOnProfile: true },
    });
    return updated;
  }

  async createAchievementDefinition(
    auth: AuthenticatedContext,
    input: {
      code: string;
      name: string;
      description: string;
      ruleType: string;
      threshold: number;
      tier: string;
      iconKey: string;
      isActive: boolean;
    },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.achievement.findUnique({ where: { code: input.code } });
    if (existing) throw new ConflictError('Achievement code already exists');

    const achievement = await this.prisma.achievement.create({ data: input });
    await this.audit.record({
      actorId: auth.userId,
      action: 'ACHIEVEMENT_CREATED',
      entityType: 'Achievement',
      entityId: achievement.id,
      metadata: { code: achievement.code, ruleType: achievement.ruleType },
      ipAddress,
    });
    return { achievement };
  }

  async updateAchievementDefinition(
    auth: AuthenticatedContext,
    achievementId: string,
    input: {
      name?: string;
      description?: string;
      ruleType?: string;
      threshold?: number;
      tier?: string;
      iconKey?: string;
      isActive?: boolean;
    },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.achievement.findUnique({ where: { id: achievementId } });
    if (!existing) throw new NotFoundError('Achievement not found');

    const achievement = await this.prisma.achievement.update({
      where: { id: achievementId },
      data: input,
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'ACHIEVEMENT_UPDATED',
      entityType: 'Achievement',
      entityId: achievementId,
      metadata: { code: achievement.code },
      ipAddress,
    });
    return { achievement };
  }
}
