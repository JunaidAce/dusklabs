import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';

function isUniqueOrBusyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'P2002' || code === 'P2034') return true;
  const msg = (err as { message?: string }).message ?? '';
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_BUSY');
}

export class HintsService {
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

  private async assertCanManageChallenge(auth: AuthenticatedContext, challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, slug: true, points: true, authorId: true, createdById: true, competitionId: true },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');

    if (this.isPlatformAdmin(auth)) return challenge;
    if (auth.roles.includes('COMPETITION_ORGANIZER') && challenge.competitionId) {
      const comp = await this.prisma.competition.findUnique({
        where: { id: challenge.competitionId },
        select: { createdById: true },
      });
      if (comp?.createdById === auth.userId) return challenge;
    }
    if (
      auth.roles.includes('CHALLENGE_AUTHOR') &&
      (challenge.authorId === auth.userId || challenge.createdById === auth.userId)
    ) {
      return challenge;
    }
    throw new ForbiddenError('You are not authorized to manage hints for this challenge');
  }

  private async resolveViewerAccess(
    viewerUserId: string | undefined,
    challenge: {
      id: string;
      status: string;
      isVisible: boolean;
      competitionId: string | null;
    },
    requireLiveForMutation: boolean,
  ): Promise<{ competitionId: string | null; teamId: string | null }> {
    if (challenge.status !== 'PUBLISHED' || !challenge.isVisible) {
      throw new NotFoundError('Challenge not found');
    }

    if (!challenge.competitionId) {
      return { competitionId: null, teamId: null };
    }

    const comp = await this.prisma.competition.findUnique({
      where: { id: challenge.competitionId },
    });
    if (!comp) throw new NotFoundError('Competition not found');

    if (!requireLiveForMutation && comp.status === 'COMPLETED') {
      return { competitionId: comp.id, teamId: null };
    }

    const now = Date.now();
    if (
      comp.status !== 'LIVE' ||
      now < comp.startsAt.getTime() ||
      now > comp.endsAt.getTime()
    ) {
      throw new ForbiddenError('Competition is not currently LIVE', 'COMPETITION_NOT_LIVE');
    }

    if (!viewerUserId) {
      throw new ForbiddenError('Authentication and competition registration required');
    }

    const reg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: viewerUserId } },
    });
    if (reg?.status === 'DISQUALIFIED') {
      throw new ForbiddenError('Registration is disqualified', 'DISQUALIFIED');
    }

    const teamMember = await this.prisma.teamMember.findFirst({
      where: {
        userId: viewerUserId,
        team: {
          deletedAt: null,
          competitions: { some: { competitionId: comp.id, status: 'CONFIRMED' } },
        },
      },
      select: { teamId: true },
    });

    if (comp.participationMode === 'TEAM') {
      if (!teamMember) {
        throw new ForbiddenError('Registered team membership required', 'COMPETITION_NOT_REGISTERED');
      }
      return { competitionId: comp.id, teamId: teamMember.teamId };
    }

    if (comp.participationMode === 'INDIVIDUAL') {
      if (!reg || reg.status !== 'CONFIRMED') {
        throw new ForbiddenError('Competition registration required', 'COMPETITION_NOT_REGISTERED');
      }
      return { competitionId: comp.id, teamId: null };
    }

    if (teamMember) return { competitionId: comp.id, teamId: teamMember.teamId };
    if (reg?.status === 'CONFIRMED') return { competitionId: comp.id, teamId: null };
    throw new ForbiddenError('Competition registration required', 'COMPETITION_NOT_REGISTERED');
  }

  async listAdminHints(auth: AuthenticatedContext, challengeId: string) {
    await this.assertCanManageChallenge(auth, challengeId);
    const hints = await this.prisma.hint.findMany({
      where: { challengeId },
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { unlocks: true } } },
    });
    return {
      hints: hints.map((h) => ({
        id: h.id,
        challengeId: h.challengeId,
        sortOrder: h.sortOrder,
        title: h.title,
        content: h.content,
        costPoints: h.costPoints,
        isAvailable: h.isAvailable,
        requiresPreviousHint: h.requiresPreviousHint,
        unlockCount: h._count.unlocks,
        createdAt: h.createdAt,
        updatedAt: h.updatedAt,
      })),
    };
  }

  async createHint(
    auth: AuthenticatedContext,
    challengeId: string,
    input: {
      sortOrder?: number;
      title: string;
      content: string;
      costPoints: number;
      isAvailable: boolean;
      requiresPreviousHint: boolean;
    },
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);

    const maxRow = await this.prisma.hint.aggregate({
      where: { challengeId },
      _max: { sortOrder: true },
    });
    const sortOrder = input.sortOrder ?? (maxRow._max.sortOrder ?? 0) + 1;

    const hint = await this.prisma.hint.create({
      data: {
        challengeId,
        sortOrder,
        title: input.title,
        content: input.content,
        costPoints: input.costPoints,
        isAvailable: input.isAvailable,
        requiresPreviousHint: input.requiresPreviousHint,
      },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'HINT_CREATED',
      entityType: 'Hint',
      entityId: hint.id,
      metadata: { challengeId, costPoints: hint.costPoints, sortOrder: hint.sortOrder },
      ipAddress,
    });

    return { hint };
  }

  async updateHint(
    auth: AuthenticatedContext,
    challengeId: string,
    hintId: string,
    input: {
      sortOrder?: number;
      title?: string;
      content?: string;
      costPoints?: number;
      isAvailable?: boolean;
      requiresPreviousHint?: boolean;
    },
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const existing = await this.prisma.hint.findFirst({ where: { id: hintId, challengeId } });
    if (!existing) throw new NotFoundError('Hint not found');

    const hint = await this.prisma.hint.update({
      where: { id: hintId },
      data: input,
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'HINT_UPDATED',
      entityType: 'Hint',
      entityId: hintId,
      metadata: { challengeId, costPoints: hint.costPoints, isAvailable: hint.isAvailable },
      ipAddress,
    });

    return { hint };
  }

  async reorderHints(
    auth: AuthenticatedContext,
    challengeId: string,
    hintIds: string[],
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const current = await this.prisma.hint.findMany({
      where: { challengeId },
      select: { id: true },
    });

    if (current.length !== hintIds.length) {
      throw new BadRequestError('hintIds must include every hint on this challenge');
    }
    const existingSet = new Set(current.map((h) => h.id));
    if (new Set(hintIds).size !== hintIds.length || hintIds.some((id) => !existingSet.has(id))) {
      throw new BadRequestError('Invalid hintIds list for reordering');
    }

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < hintIds.length; i++) {
        await tx.hint.update({
          where: { id: hintIds[i]! },
          data: { sortOrder: -(i + 1) },
        });
      }
      for (let i = 0; i < hintIds.length; i++) {
        await tx.hint.update({
          where: { id: hintIds[i]! },
          data: { sortOrder: i + 1 },
        });
      }
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'HINTS_REORDERED',
      entityType: 'Challenge',
      entityId: challengeId,
      ipAddress,
    });

    return this.listAdminHints(auth, challengeId);
  }

  async deleteHint(
    auth: AuthenticatedContext,
    challengeId: string,
    hintId: string,
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const existing = await this.prisma.hint.findFirst({
      where: { id: hintId, challengeId },
      include: { _count: { select: { unlocks: true } } },
    });
    if (!existing) throw new NotFoundError('Hint not found');

    if (existing._count.unlocks > 0) {
      throw new ConflictError(
        'Cannot delete a hint that has already been unlocked; disable it instead',
        'HINT_HAS_UNLOCKS',
      );
    }

    await this.prisma.hint.delete({ where: { id: hintId } });
    await this.audit.record({
      actorId: auth.userId,
      action: 'HINT_DELETED',
      entityType: 'Hint',
      entityId: hintId,
      metadata: { challengeId },
      ipAddress,
    });
    return { deleted: true };
  }

  async listChallengeHintsForParticipant(idOrSlug: string, viewerUserId?: string) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: {
        id: true,
        slug: true,
        status: true,
        isVisible: true,
        points: true,
        allowNegativeScore: true,
        competitionId: true,
      },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');

    const { teamId } = await this.resolveViewerAccess(viewerUserId, challenge, false);

    const hints = await this.prisma.hint.findMany({
      where: { challengeId: challenge.id, isAvailable: true },
      orderBy: { sortOrder: 'asc' },
    });

    let unlocks: Array<{ hintId: string; costApplied: number; unlockedAt: Date }> = [];
    if (viewerUserId && hints.length > 0) {
      unlocks = await this.prisma.hintUnlock.findMany({
        where: {
          hintId: { in: hints.map((h) => h.id) },
          ...(teamId ? { OR: [{ userId: viewerUserId }, { teamId }] } : { userId: viewerUserId }),
        },
        select: { hintId: true, costApplied: true, unlockedAt: true },
      });
    }

    const unlockByHintId = new Map(unlocks.map((u) => [u.hintId, u]));
    const totalPenaltiesApplied = unlocks.reduce((acc, u) => acc + u.costApplied, 0);
    const effectivePointsCurrent = challenge.allowNegativeScore
      ? challenge.points - totalPenaltiesApplied
      : Math.max(0, challenge.points - totalPenaltiesApplied);

    return {
      challengeBasePoints: challenge.points,
      totalPenaltiesApplied,
      effectivePointsCurrent,
      allowNegativeScore: challenge.allowNegativeScore,
      hints: hints.map((h, idx) => {
        const unlock = unlockByHintId.get(h.id);
        const prevHint = idx > 0 ? hints[idx - 1] : null;
        const previousUnlocked = !prevHint || unlockByHintId.has(prevHint.id);
        const prerequisiteMet = !h.requiresPreviousHint || previousUnlocked;

        const projectedCost = challenge.allowNegativeScore
          ? h.costPoints
          : Math.min(h.costPoints, Math.max(0, effectivePointsCurrent));

        const effectivePointsAfterUnlock = unlock
          ? effectivePointsCurrent
          : challenge.allowNegativeScore
            ? effectivePointsCurrent - h.costPoints
            : Math.max(0, effectivePointsCurrent - projectedCost);

        return {
          id: h.id,
          sortOrder: h.sortOrder,
          title: h.title,
          costPoints: h.costPoints,
          projectedCost,
          requiresPreviousHint: h.requiresPreviousHint,
          prerequisiteMet,
          unlocked: Boolean(unlock),
          unlockedAt: unlock?.unlockedAt ?? null,
          costApplied: unlock?.costApplied ?? null,
          effectivePointsBeforeUnlock: effectivePointsCurrent,
          effectivePointsAfterUnlock,
          content: unlock ? h.content : null,
        };
      }),
    };
  }

  async unlockHint(
    auth: AuthenticatedContext,
    idOrSlug: string,
    hintId: string,
    ipAddress?: string,
  ) {
    const challenge = await this.prisma.challenge.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: {
        id: true,
        slug: true,
        status: true,
        isVisible: true,
        points: true,
        allowNegativeScore: true,
        authorId: true,
        createdById: true,
        competitionId: true,
      },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');

    if (challenge.authorId === auth.userId || challenge.createdById === auth.userId) {
      throw new ForbiddenError('Challenge authors cannot unlock scored hints on their own challenge');
    }

    const { competitionId, teamId } = await this.resolveViewerAccess(auth.userId, challenge, true);

    const availableHints = await this.prisma.hint.findMany({
      where: { challengeId: challenge.id, isAvailable: true },
      orderBy: { sortOrder: 'asc' },
    });

    const targetIndex = availableHints.findIndex((h) => h.id === hintId);
    if (targetIndex === -1) {
      throw new NotFoundError('Hint not found or unavailable');
    }
    const targetHint = availableHints[targetIndex]!;

    let unlockResult: { unlockId: string; costApplied: number; effectivePointsRemaining: number };
    try {
      unlockResult = await this.prisma.$transaction(async (tx) => {
        const hintIds = availableHints.map((h) => h.id);
        const existingUnlocks = await tx.hintUnlock.findMany({
          where: {
            hintId: { in: hintIds },
            ...(teamId ? { OR: [{ userId: auth.userId }, { teamId }] } : { userId: auth.userId }),
          },
        });

        if (existingUnlocks.some((u) => u.hintId === targetHint.id)) {
          throw new ConflictError('Hint has already been unlocked', 'HINT_ALREADY_UNLOCKED');
        }

        if (targetHint.requiresPreviousHint && targetIndex > 0) {
          const prevHint = availableHints[targetIndex - 1]!;
          if (!existingUnlocks.some((u) => u.hintId === prevHint.id)) {
            throw new BadRequestError(
              `Hint #${prevHint.sortOrder} must be unlocked before this hint`,
              'PREVIOUS_HINT_REQUIRED',
            );
          }
        }

        const priorPenalties = existingUnlocks.reduce((sum, u) => sum + u.costApplied, 0);
        const effectiveBefore = challenge.points - priorPenalties;
        const costApplied = challenge.allowNegativeScore
          ? targetHint.costPoints
          : Math.min(targetHint.costPoints, Math.max(0, effectiveBefore));

        const unlock = await tx.hintUnlock.create({
          data: {
            hintId: targetHint.id,
            userId: auth.userId,
            teamId,
            competitionId,
            costApplied,
          },
        });

        if (costApplied > 0) {
          await tx.scoreTransaction.create({
            data: {
              userId: auth.userId,
              teamId,
              competitionId,
              hintUnlockId: unlock.id,
              deltaPoints: -costApplied,
              type: 'HINT_PENALTY',
              reason: `Unlocked hint "${targetHint.title}" on ${challenge.slug}`,
            },
          });
        }

        const effectivePointsRemaining = challenge.allowNegativeScore
          ? effectiveBefore - costApplied
          : Math.max(0, effectiveBefore - costApplied);

        return { unlockId: unlock.id, costApplied, effectivePointsRemaining };
      });
    } catch (err) {
      if (err instanceof ConflictError || err instanceof BadRequestError) throw err;
      if (isUniqueOrBusyError(err)) {
        throw new ConflictError('Hint has already been unlocked', 'HINT_ALREADY_UNLOCKED');
      }
      throw err;
    }

    await this.audit.record({
      actorId: auth.userId,
      action: 'HINT_UNLOCKED',
      entityType: 'HintUnlock',
      entityId: unlockResult.unlockId,
      metadata: {
        challengeId: challenge.id,
        hintId: targetHint.id,
        teamId,
        costApplied: unlockResult.costApplied,
      },
      ipAddress,
    });

    return {
      unlocked: true,
      hint: {
        id: targetHint.id,
        sortOrder: targetHint.sortOrder,
        title: targetHint.title,
        content: targetHint.content,
        costApplied: unlockResult.costApplied,
      },
      effectivePointsRemaining: unlockResult.effectivePointsRemaining,
    };
  }
}
