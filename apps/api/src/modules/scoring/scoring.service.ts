import type { RoleName } from '@dusklabs/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';

export function computeDynamicPoints(params: {
  initialPoints: number;
  minPoints: number;
  decayRate: number;
  solveCount: number;
}): number {
  const { initialPoints, minPoints, decayRate, solveCount } = params;
  if (solveCount <= 1) return initialPoints;
  const safeDecay = Math.max(1, decayRate);
  const ratio = Math.min(1, Math.max(0, solveCount - 1) / safeDecay);
  const raw = Math.ceil(initialPoints - (initialPoints - minPoints) * ratio * ratio);
  return Math.max(minPoints, Math.min(initialPoints, raw));
}

export interface RankedEntry {
  rank: number;
  entityId: string;
  entityType: 'INDIVIDUAL' | 'TEAM';
  name: string;
  slugOrUsername: string;
  country: string | null;
  totalPoints: number;
  solveCount: number;
  firstBloodCount: number;
  lastSolveAt: Date | null;
}

export class ScoringService {
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

  private async assertScoreManageAccess(
    auth: AuthenticatedContext,
    competitionId: string | null | undefined,
  ): Promise<void> {
    if (this.isPlatformAdmin(auth)) return;
    if (auth.roles.includes('COMPETITION_ORGANIZER') && competitionId) {
      const comp = await this.prisma.competition.findUnique({
        where: { id: competitionId },
        select: { createdById: true },
      });
      if (comp?.createdById === auth.userId) return;
    }
    throw new ForbiddenError('Insufficient permissions to adjust or recalculate scores');
  }

  async recordValidatedSolve(
    tx: Prisma.TransactionClient,
    params: {
      challenge: {
        id: string;
        slug: string;
        scoringMode: string;
        points: number;
        initialPoints: number;
        minPoints: number;
        decayRate: number;
        firstBloodBonus: number;
      };
      competition: {
        id: string;
        scoringMode: string;
        dynamicScoringPolicy: string;
        firstBloodEnabled: boolean;
      } | null;
      userId: string;
      teamId: string | null;
    },
  ): Promise<{
    solveId: string;
    pointsAwarded: number;
    firstBloodBonusAwarded: number;
    isFirstBlood: boolean;
  }> {
    const { challenge, competition, userId, teamId } = params;
    const scopeWhere = teamId
      ? { challengeId: challenge.id, OR: [{ userId }, { teamId }] }
      : { challengeId: challenge.id, userId };

    const duplicate = await tx.solve.findFirst({ where: scopeWhere });
    if (duplicate) {
      throw new ConflictError('Challenge has already been solved', 'ALREADY_SOLVED');
    }

    const priorSolves = await tx.solve.findMany({
      where: { challengeId: challenge.id },
      orderBy: { solvedAt: 'asc' },
    });
    const newSolveCount = priorSolves.length + 1;

    const effectiveScoringMode =
      competition?.scoringMode === 'DYNAMIC' || challenge.scoringMode === 'DYNAMIC'
        ? 'DYNAMIC'
        : 'STATIC';

    const pointsAwarded =
      effectiveScoringMode === 'DYNAMIC'
        ? computeDynamicPoints({
            initialPoints: challenge.initialPoints,
            minPoints: challenge.minPoints,
            decayRate: challenge.decayRate,
            solveCount: newSolveCount,
          })
        : challenge.points;

    const fbEnabled = competition ? competition.firstBloodEnabled : true;
    let isFirstBlood = false;
    if (fbEnabled && priorSolves.length === 0) {
      const claim = await tx.challenge.updateMany({
        where: { id: challenge.id, firstBloodUserId: null },
        data: {
          firstBloodUserId: userId,
          firstBloodTeamId: teamId,
          firstBloodAt: new Date(),
        },
      });
      isFirstBlood = claim.count === 1;
    }

    const solve = await tx.solve.create({
      data: {
        challengeId: challenge.id,
        competitionId: competition?.id ?? null,
        userId,
        teamId,
        isFirstBlood,
        firstBloodChallengeId: isFirstBlood ? challenge.id : null,
        pointsAwarded,
      },
    });

    await tx.scoreTransaction.create({
      data: {
        userId,
        teamId,
        competitionId: competition?.id ?? null,
        solveId: solve.id,
        idempotencyKey: `solve:${solve.id}`,
        deltaPoints: pointsAwarded,
        type: 'SOLVE',
        reason: `Solved challenge ${challenge.slug}`,
      },
    });

    let firstBloodBonusAwarded = 0;
    if (isFirstBlood && challenge.firstBloodBonus > 0) {
      firstBloodBonusAwarded = challenge.firstBloodBonus;
      await tx.scoreTransaction.create({
        data: {
          userId,
          teamId,
          competitionId: competition?.id ?? null,
          solveId: solve.id,
          idempotencyKey: `first_blood:${challenge.id}`,
          deltaPoints: firstBloodBonusAwarded,
          type: 'FIRST_BLOOD',
          reason: `First Blood bonus on ${challenge.slug}`,
        },
      });
    }

    if (effectiveScoringMode === 'DYNAMIC') {
      await tx.challenge.update({
        where: { id: challenge.id },
        data: { points: pointsAwarded },
      });

      const policy = competition?.dynamicScoringPolicy ?? 'RETROACTIVE';
      if (policy === 'RETROACTIVE') {
        for (const prev of priorSolves) {
          const delta = pointsAwarded - prev.pointsAwarded;
          if (delta !== 0) {
            await tx.solve.update({
              where: { id: prev.id },
              data: { pointsAwarded },
            });
            await tx.scoreTransaction.create({
              data: {
                userId: prev.userId,
                teamId: prev.teamId,
                competitionId: competition?.id ?? null,
                solveId: prev.id,
                idempotencyKey: `dyn:${prev.id}:s${newSolveCount}`,
                deltaPoints: delta,
                type: 'DYNAMIC_RECALC',
                reason: `Dynamic decay adjustment on ${challenge.slug} (${newSolveCount} solves)`,
              },
            });
          }
        }
      }
    }

    return {
      solveId: solve.id,
      pointsAwarded,
      firstBloodBonusAwarded,
      isFirstBlood,
    };
  }

  async adjustScore(
    auth: AuthenticatedContext,
    input: {
      userId: string;
      teamId?: string | null;
      competitionId?: string | null;
      deltaPoints: number;
      reason: string;
    },
    ipAddress?: string,
  ) {
    await this.assertScoreManageAccess(auth, input.competitionId);

    const targetUser = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!targetUser) throw new NotFoundError('Target user not found');

    if (input.teamId) {
      const targetTeam = await this.prisma.team.findUnique({ where: { id: input.teamId } });
      if (!targetTeam) throw new NotFoundError('Target team not found');
    }

    const txRecord = await this.prisma.scoreTransaction.create({
      data: {
        userId: input.userId,
        teamId: input.teamId ?? null,
        competitionId: input.competitionId ?? null,
        deltaPoints: input.deltaPoints,
        type: 'MANUAL_ADJUSTMENT',
        reason: input.reason,
        actorId: auth.userId,
      },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'SCORE_MANUALLY_ADJUSTED',
      entityType: 'ScoreTransaction',
      entityId: txRecord.id,
      metadata: {
        targetUserId: input.userId,
        teamId: input.teamId ?? null,
        competitionId: input.competitionId ?? null,
        deltaPoints: input.deltaPoints,
        reason: input.reason,
      },
      ipAddress,
    });

    return { transaction: txRecord };
  }

  async recalculateCompetitionScores(
    auth: AuthenticatedContext,
    competitionId: string,
    ipAddress?: string,
  ) {
    await this.assertScoreManageAccess(auth, competitionId);

    const comp = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      include: {
        challenges: {
          include: {
            solves: { orderBy: { solvedAt: 'asc' } },
          },
        },
      },
    });
    if (!comp) throw new NotFoundError('Competition not found');

    let adjustmentsCreated = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const chal of comp.challenges) {
        const isDynamic = comp.scoringMode === 'DYNAMIC' || chal.scoringMode === 'DYNAMIC';
        if (!isDynamic || chal.solves.length === 0) continue;

        const targetPoints = computeDynamicPoints({
          initialPoints: chal.initialPoints,
          minPoints: chal.minPoints,
          decayRate: chal.decayRate,
          solveCount: chal.solves.length,
        });

        await tx.challenge.update({
          where: { id: chal.id },
          data: { points: targetPoints },
        });

        if (comp.dynamicScoringPolicy === 'RETROACTIVE') {
          for (const solve of chal.solves) {
            const sumAgg = await tx.scoreTransaction.aggregate({
              where: { solveId: solve.id, type: { in: ['SOLVE', 'DYNAMIC_RECALC'] } },
              _sum: { deltaPoints: true },
            });
            const currentNet = sumAgg._sum.deltaPoints ?? 0;
            const delta = targetPoints - currentNet;
            if (delta !== 0) {
              await tx.solve.update({
                where: { id: solve.id },
                data: { pointsAwarded: targetPoints },
              });
              await tx.scoreTransaction.create({
                data: {
                  userId: solve.userId,
                  teamId: solve.teamId,
                  competitionId: comp.id,
                  solveId: solve.id,
                  deltaPoints: delta,
                  type: 'DYNAMIC_RECALC',
                  reason: `Admin recalculation on ${chal.slug}`,
                  actorId: auth.userId,
                },
              });
              adjustmentsCreated++;
            }
          }
        }
      }
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_SCORES_RECALCULATED',
      entityType: 'Competition',
      entityId: competitionId,
      metadata: { adjustmentsCreated },
      ipAddress,
    });

    return { recalculated: true, adjustmentsCreated };
  }

  async computeStandings(params: {
    competitionId?: string | null;
    entityType: 'INDIVIDUAL' | 'TEAM';
    allowNegative?: boolean;
  }): Promise<RankedEntry[]> {
    const { competitionId, entityType, allowNegative = false } = params;

    const txWhere: Prisma.ScoreTransactionWhereInput =
      competitionId !== undefined ? { competitionId } : {};
    const solveWhere: Prisma.SolveWhereInput =
      competitionId !== undefined ? { competitionId } : {};

    const [transactions, solves] = await Promise.all([
      this.prisma.scoreTransaction.findMany({
        where: txWhere,
        select: { userId: true, teamId: true, deltaPoints: true },
      }),
      this.prisma.solve.findMany({
        where: solveWhere,
        select: { userId: true, teamId: true, isFirstBlood: true, solvedAt: true },
      }),
    ]);

    const scoreMap = new Map<string, number>();
    const solveCountMap = new Map<string, number>();
    const fbCountMap = new Map<string, number>();
    const lastSolveMap = new Map<string, Date>();

    for (const t of transactions) {
      // INDIVIDUAL standings attribute every transaction to its user (including
      // team-competition solves, so global INDIVIDUAL includes team players);
      // TEAM standings attribute to the team.
      const resolvedKey = entityType === 'TEAM' ? t.teamId : t.userId;
      if (!resolvedKey) continue;
      scoreMap.set(resolvedKey, (scoreMap.get(resolvedKey) ?? 0) + t.deltaPoints);
    }

    for (const s of solves) {
      const resolvedKey = entityType === 'TEAM' ? s.teamId : s.userId;
      if (!resolvedKey) continue;
      solveCountMap.set(resolvedKey, (solveCountMap.get(resolvedKey) ?? 0) + 1);
      if (s.isFirstBlood) {
        fbCountMap.set(resolvedKey, (fbCountMap.get(resolvedKey) ?? 0) + 1);
      }
      const prev = lastSolveMap.get(resolvedKey);
      if (!prev || s.solvedAt > prev) {
        lastSolveMap.set(resolvedKey, s.solvedAt);
      }
    }

    const entityIds = Array.from(new Set([...scoreMap.keys(), ...solveCountMap.keys()]));
    if (entityIds.length === 0) return [];

    const entries: RankedEntry[] = [];

    if (entityType === 'TEAM') {
      const teams = await this.prisma.team.findMany({
        where: { id: { in: entityIds }, deletedAt: null },
        select: { id: true, name: true, slug: true },
      });
      for (const team of teams) {
        const rawTotal = scoreMap.get(team.id) ?? 0;
        entries.push({
          rank: 0,
          entityId: team.id,
          entityType: 'TEAM',
          name: team.name,
          slugOrUsername: team.slug,
          country: null,
          totalPoints: allowNegative ? rawTotal : Math.max(0, rawTotal),
          solveCount: solveCountMap.get(team.id) ?? 0,
          firstBloodCount: fbCountMap.get(team.id) ?? 0,
          lastSolveAt: lastSolveMap.get(team.id) ?? null,
        });
      }
    } else {
      const users = await this.prisma.user.findMany({
        where: { id: { in: entityIds }, deletedAt: null, accountStatus: 'ACTIVE' },
        select: { id: true, username: true, displayName: true, country: true },
      });
      for (const u of users) {
        const rawTotal = scoreMap.get(u.id) ?? 0;
        entries.push({
          rank: 0,
          entityId: u.id,
          entityType: 'INDIVIDUAL',
          name: u.displayName,
          slugOrUsername: u.username,
          country: u.country,
          totalPoints: allowNegative ? rawTotal : Math.max(0, rawTotal),
          solveCount: solveCountMap.get(u.id) ?? 0,
          firstBloodCount: fbCountMap.get(u.id) ?? 0,
          lastSolveAt: lastSolveMap.get(u.id) ?? null,
        });
      }
    }

    entries.sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.solveCount !== a.solveCount) return b.solveCount - a.solveCount;
      if (a.lastSolveAt && b.lastSolveAt) {
        const diff = a.lastSolveAt.getTime() - b.lastSolveAt.getTime();
        if (diff !== 0) return diff;
      } else if (a.lastSolveAt || b.lastSolveAt) {
        return a.lastSolveAt ? -1 : 1;
      }
      return a.entityId.localeCompare(b.entityId);
    });

    entries.forEach((e, idx) => {
      e.rank = idx + 1;
    });

    return entries;
  }
}
