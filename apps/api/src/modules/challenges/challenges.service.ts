import type { ChallengeStatus, FlagType, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import {
  buildStoredFlagRecord,
  type FlagCryptoConfig,
  verifyCandidateFlag,
} from '../../utils/flagCrypto.js';

const VALID_CHALLENGE_TRANSITIONS: Record<ChallengeStatus, readonly ChallengeStatus[]> = {
  DRAFT: ['TESTING', 'PUBLISHED', 'ARCHIVED'],
  TESTING: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['TESTING', 'ARCHIVED'],
  ARCHIVED: ['DRAFT', 'TESTING'],
};

const PUBLIC_CHALLENGE_SELECT = {
  id: true,
  slug: true,
  title: true,
  description: true,
  connectionInfo: true,
  difficulty: true,
  challengeType: true,
  status: true,
  isVisible: true,
  scoringMode: true,
  points: true,
  initialPoints: true,
  minPoints: true,
  firstBloodBonus: true,
  maxAttempts: true,
  competitionId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, username: true, displayName: true } },
  competition: { select: { id: true, slug: true, title: true, status: true } },
  categories: { select: { category: { select: { id: true, slug: true, name: true } } } },
  tags: { select: { tag: true } },
  _count: { select: { solves: true, hints: true, attachments: true } },
} as const;

export class ChallengesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly flagCrypto: FlagCryptoConfig,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async assertChallengeManageAccess(
    auth: AuthenticatedContext,
    challenge: {
      id: string;
      authorId: string | null;
      createdById: string | null;
      competitionId: string | null;
    },
  ): Promise<void> {
    if (this.isPlatformAdmin(auth)) return;

    if (auth.roles.includes('COMPETITION_ORGANIZER') && challenge.competitionId) {
      const comp = await this.prisma.competition.findUnique({
        where: { id: challenge.competitionId },
        select: { createdById: true },
      });
      if (comp?.createdById === auth.userId) return;
    }

    if (
      auth.roles.includes('CHALLENGE_AUTHOR') &&
      (challenge.authorId === auth.userId || challenge.createdById === auth.userId)
    ) {
      return;
    }

    throw new ForbiddenError('You are not authorized to manage this challenge');
  }

  private async assertCompetitionAssignmentAccess(
    auth: AuthenticatedContext,
    competitionId: string | null | undefined,
  ): Promise<void> {
    if (!competitionId) return;
    const comp = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      select: { id: true, createdById: true },
    });
    if (!comp) {
      throw new NotFoundError('Associated competition not found');
    }
    if (this.isPlatformAdmin(auth)) return;
    if (auth.roles.includes('COMPETITION_ORGANIZER') && comp.createdById === auth.userId) return;

    throw new ForbiddenError('You cannot assign challenges to a competition you do not organize');
  }

  private async userHasCompetitionAccess(
    userId: string | undefined,
    competition: { id: string; status: string },
  ): Promise<boolean> {
    if (competition.status === 'COMPLETED') {
      return true;
    }
    if (competition.status !== 'LIVE') {
      return false;
    }
    if (!userId) return false;

    const reg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId: competition.id, userId } },
    });
    if (reg && reg.status === 'CONFIRMED') return true;

    const teamMembership = await this.prisma.teamMember.findFirst({
      where: {
        userId,
        team: {
          deletedAt: null,
          competitions: { some: { competitionId: competition.id, status: 'CONFIRMED' } },
        },
      },
    });
    return Boolean(teamMembership);
  }

  async listCategories() {
    const categories = await this.prisma.category.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { challenges: true } } },
    });
    return {
      categories: categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
        challengeCount: c._count.challenges,
      })),
    };
  }

  async createCategory(
    actorId: string,
    input: { slug: string; name: string; description?: string; sortOrder: number },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.category.findFirst({
      where: { OR: [{ slug: input.slug }, { name: input.name }] },
    });
    if (existing) throw new ConflictError('Category slug or name already exists');

    const category = await this.prisma.category.create({ data: input });
    await this.audit.record({
      actorId,
      action: 'CATEGORY_CREATED',
      entityType: 'Category',
      entityId: category.id,
      metadata: { slug: category.slug },
      ipAddress,
    });
    return { category };
  }

  async updateCategory(
    categoryId: string,
    actorId: string,
    input: { slug?: string; name?: string; description?: string; sortOrder?: number },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!existing) throw new NotFoundError('Category not found');

    const category = await this.prisma.category.update({
      where: { id: categoryId },
      data: input,
    });
    await this.audit.record({
      actorId,
      action: 'CATEGORY_UPDATED',
      entityType: 'Category',
      entityId: categoryId,
      ipAddress,
    });
    return { category };
  }

  async deleteCategory(categoryId: string, actorId: string, ipAddress?: string) {
    const usageCount = await this.prisma.challengeCategory.count({ where: { categoryId } });
    if (usageCount > 0) {
      throw new ConflictError('Cannot delete a category assigned to existing challenges');
    }
    await this.prisma.category.delete({ where: { id: categoryId } });
    await this.audit.record({
      actorId,
      action: 'CATEGORY_DELETED',
      entityType: 'Category',
      entityId: categoryId,
      ipAddress,
    });
    return { deleted: true };
  }

  async listPublicChallenges(
    query: {
      search?: string;
      category?: string;
      difficulty?: string;
      tag?: string;
      competitionSlug?: string;
      sort?: 'newest' | 'points_asc' | 'points_desc' | 'title';
      page?: number;
      limit?: number;
    },
    viewerUserId?: string,
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));

    let competitionFilter: Record<string, unknown> = {
      OR: [
        { competitionId: null },
        { competition: { status: { in: ['LIVE', 'COMPLETED'] } } },
      ],
    };

    if (query.competitionSlug) {
      const comp = await this.prisma.competition.findUnique({
        where: { slug: query.competitionSlug },
        select: { id: true, status: true },
      });
      if (!comp) throw new NotFoundError('Competition not found');
      const allowed = await this.userHasCompetitionAccess(viewerUserId, comp);
      if (!allowed) {
        throw new ForbiddenError('You do not have access to challenges in this competition');
      }
      competitionFilter = { competitionId: comp.id };
    }

    const search = query.search?.trim();
    const where: any = {
      AND: [
        { status: 'PUBLISHED', isVisible: true },
        competitionFilter,
        ...(query.difficulty ? [{ difficulty: query.difficulty }] : []),
        ...(query.category
          ? [{ categories: { some: { category: { slug: query.category } } } }]
          : []),
        ...(query.tag ? [{ tags: { some: { tag: query.tag.toLowerCase() } } }] : []),
        ...(search
          ? [{ OR: [{ title: { contains: search } }, { description: { contains: search } }] }]
          : []),
      ],
    };

    const orderBy =
      query.sort === 'points_asc'
        ? { points: 'asc' as const }
        : query.sort === 'points_desc'
          ? { points: 'desc' as const }
          : query.sort === 'title'
            ? { title: 'asc' as const }
            : { createdAt: 'desc' as const };

    const allMatched = await this.prisma.challenge.findMany({
      where,
      orderBy,
      select: PUBLIC_CHALLENGE_SELECT,
    });

    const accessible: typeof allMatched = [];
    for (const c of allMatched) {
      if (!c.competition) {
        accessible.push(c);
      } else if (await this.userHasCompetitionAccess(viewerUserId, c.competition)) {
        accessible.push(c);
      }
    }

    const total = accessible.length;
    const paged = accessible.slice((page - 1) * limit, page * limit);

    return {
      challenges: paged.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        difficulty: c.difficulty,
        challengeType: c.challengeType,
        scoringMode: c.scoringMode,
        points: c.points,
        firstBloodBonus: c.firstBloodBonus,
        competition: c.competition,
        author: c.author,
        categories: c.categories.map((cc) => cc.category),
        tags: c.tags.map((t) => t.tag),
        solveCount: c._count.solves,
        hintCount: c._count.hints,
        attachmentCount: c._count.attachments,
        createdAt: c.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getPublicChallengeBySlug(slug: string, viewerUserId?: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { slug },
      select: PUBLIC_CHALLENGE_SELECT,
    });

    if (!challenge || challenge.status !== 'PUBLISHED' || !challenge.isVisible) {
      throw new NotFoundError('Challenge not found');
    }

    if (challenge.competition) {
      const allowed = await this.userHasCompetitionAccess(viewerUserId, challenge.competition);
      if (!allowed) {
        throw new ForbiddenError('Competition registration or LIVE window required');
      }
    }

    let mySolve: { solvedAt: Date; pointsAwarded: number; isFirstBlood: boolean } | null = null;
    let attemptCount = 0;

    if (viewerUserId) {
      let resolvedTeamId: string | null = null;
      if (challenge.competition) {
        const tm = await this.prisma.teamMember.findFirst({
          where: {
            userId: viewerUserId,
            team: {
              deletedAt: null,
              competitions: { some: { competitionId: challenge.competition.id, status: 'CONFIRMED' } },
            },
          },
          select: { teamId: true },
        });
        resolvedTeamId = tm?.teamId ?? null;
      }

      const solve = await this.prisma.solve.findFirst({
        where: {
          challengeId: challenge.id,
          ...(resolvedTeamId ? { OR: [{ userId: viewerUserId }, { teamId: resolvedTeamId }] } : { userId: viewerUserId }),
        },
        select: { solvedAt: true, pointsAwarded: true, isFirstBlood: true },
      });
      mySolve = solve;

      attemptCount = await this.prisma.submission.count({
        where: {
          challengeId: challenge.id,
          ...(resolvedTeamId ? { OR: [{ userId: viewerUserId }, { teamId: resolvedTeamId }] } : { userId: viewerUserId }),
        },
      });
    }

    return {
      challenge: {
        id: challenge.id,
        slug: challenge.slug,
        title: challenge.title,
        description: challenge.description,
        connectionInfo: challenge.connectionInfo,
        difficulty: challenge.difficulty,
        challengeType: challenge.challengeType,
        scoringMode: challenge.scoringMode,
        points: challenge.points,
        firstBloodBonus: challenge.firstBloodBonus,
        maxAttempts: challenge.maxAttempts,
        mySolve,
        attemptCount,
        competition: challenge.competition,
        author: challenge.author,
        categories: challenge.categories.map((cc) => cc.category),
        tags: challenge.tags.map((t) => t.tag),
        solveCount: challenge._count.solves,
        hintCount: challenge._count.hints,
        attachmentCount: challenge._count.attachments,
        createdAt: challenge.createdAt,
        updatedAt: challenge.updatedAt,
      },
    };
  }

  async listAdminChallenges(auth: AuthenticatedContext, statusFilter?: string) {
    const isAdmin = this.isPlatformAdmin(auth);
    const where: any = {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(!isAdmin
        ? {
            OR: [
              { authorId: auth.userId },
              { createdById: auth.userId },
              ...(auth.roles.includes('COMPETITION_ORGANIZER')
                ? [{ competition: { createdById: auth.userId } }]
                : []),
            ],
          }
        : {}),
    };

    const challenges = await this.prisma.challenge.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        ...PUBLIC_CHALLENGE_SELECT,
        flagConfiguration: {
          select: { flagType: true, dynamicPattern: true, updatedAt: true },
        },
      },
    });

    return {
      challenges: challenges.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        difficulty: c.difficulty,
        status: c.status,
        isVisible: c.isVisible,
        points: c.points,
        competition: c.competition,
        author: c.author,
        categories: c.categories.map((cc) => cc.category),
        tags: c.tags.map((t) => t.tag),
        hasFlag: Boolean(c.flagConfiguration),
        flagType: c.flagConfiguration?.flagType ?? null,
        solveCount: c._count.solves,
        updatedAt: c.updatedAt,
      })),
    };
  }

  async getAdminChallengeById(auth: AuthenticatedContext, challengeId: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: {
        ...PUBLIC_CHALLENGE_SELECT,
        createdById: true,
        authorId: true,
        decayRate: true,
        flagConfiguration: {
          select: { id: true, flagType: true, dynamicPattern: true, updatedAt: true },
        },
      },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, challenge);

    return {
      challenge: {
        id: challenge.id,
        slug: challenge.slug,
        title: challenge.title,
        description: challenge.description,
        connectionInfo: challenge.connectionInfo,
        difficulty: challenge.difficulty,
        challengeType: challenge.challengeType,
        status: challenge.status,
        isVisible: challenge.isVisible,
        scoringMode: challenge.scoringMode,
        points: challenge.points,
        initialPoints: challenge.initialPoints,
        minPoints: challenge.minPoints,
        decayRate: challenge.decayRate,
        firstBloodBonus: challenge.firstBloodBonus,
        maxAttempts: challenge.maxAttempts,
        competitionId: challenge.competitionId,
        authorId: challenge.authorId,
        categories: challenge.categories.map((cc) => cc.category),
        tags: challenge.tags.map((t) => t.tag),
        flagMetadata: challenge.flagConfiguration,
        createdAt: challenge.createdAt,
        updatedAt: challenge.updatedAt,
      },
    };
  }

  async createChallenge(
    auth: AuthenticatedContext,
    input: {
      slug: string;
      title: string;
      description: string;
      connectionInfo?: string | null;
      difficulty: string;
      challengeType: string;
      status: ChallengeStatus;
      isVisible: boolean;
      scoringMode: string;
      points: number;
      initialPoints: number;
      minPoints: number;
      decayRate: number;
      firstBloodBonus: number;
      maxAttempts: number;
      competitionId?: string | null;
      authorId?: string | null;
      categoryIds: string[];
      tags: string[];
      flagConfig?: { flagType: FlagType; flagValue: string; dynamicPattern?: string };
    },
    ipAddress?: string,
  ) {
    if (input.status === 'PUBLISHED' && !input.flagConfig) {
      throw new BadRequestError(
        'Cannot create a challenge directly in PUBLISHED status without a flag configuration',
        'FLAG_REQUIRED_BEFORE_PUBLISH',
      );
    }

    await this.assertCompetitionAssignmentAccess(auth, input.competitionId);

    const existingSlug = await this.prisma.challenge.findUnique({ where: { slug: input.slug } });
    if (existingSlug) throw new ConflictError('Challenge slug already exists');

    const catCount = await this.prisma.category.count({
      where: { id: { in: input.categoryIds } },
    });
    if (catCount !== input.categoryIds.length) {
      throw new BadRequestError('One or more categoryIds are invalid');
    }

    const resolvedAuthorId =
      input.authorId !== undefined
        ? this.isPlatformAdmin(auth)
          ? input.authorId
          : auth.userId
        : auth.userId;

    const normalizedTags = Array.from(
      new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    );

    const challenge = await this.prisma.$transaction(async (tx) => {
      return tx.challenge.create({
        data: {
          slug: input.slug,
          title: input.title,
          description: input.description,
          connectionInfo: input.connectionInfo?.trim() || null,
          difficulty: input.difficulty,
          challengeType: input.challengeType,
          status: input.status,
          isVisible: input.status === 'PUBLISHED' ? true : input.isVisible,
          scoringMode: input.scoringMode,
          points: input.points,
          initialPoints: input.initialPoints,
          minPoints: input.minPoints,
          decayRate: input.decayRate,
          firstBloodBonus: input.firstBloodBonus,
          maxAttempts: input.maxAttempts,
          competitionId: input.competitionId ?? null,
          authorId: resolvedAuthorId,
          createdById: auth.userId,
          categories: {
            create: input.categoryIds.map((categoryId) => ({ categoryId })),
          },
          tags: {
            create: normalizedTags.map((tag) => ({ tag })),
          },
          ...(input.flagConfig
            ? {
                flagConfiguration: {
                  create: buildStoredFlagRecord(input.flagConfig, this.flagCrypto),
                },
              }
            : {}),
        },
        select: PUBLIC_CHALLENGE_SELECT,
      });
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_CREATED',
      entityType: 'Challenge',
      entityId: challenge.id,
      metadata: { slug: challenge.slug, status: challenge.status },
      ipAddress,
    });

    return { challenge };
  }

  async updateChallenge(
    auth: AuthenticatedContext,
    challengeId: string,
    input: {
      slug?: string;
      title?: string;
      description?: string;
      connectionInfo?: string | null;
      difficulty?: string;
      challengeType?: string;
      isVisible?: boolean;
      scoringMode?: string;
      points?: number;
      initialPoints?: number;
      minPoints?: number;
      decayRate?: number;
      firstBloodBonus?: number;
      maxAttempts?: number;
      competitionId?: string | null;
      authorId?: string | null;
      categoryIds?: string[];
      tags?: string[];
    },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, slug: true, authorId: true, createdById: true, competitionId: true },
    });
    if (!existing) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, existing);

    if (input.competitionId !== undefined && input.competitionId !== existing.competitionId) {
      await this.assertCompetitionAssignmentAccess(auth, input.competitionId);
    }

    if (input.slug && input.slug !== existing.slug) {
      const slugConflict = await this.prisma.challenge.findUnique({ where: { slug: input.slug } });
      if (slugConflict) throw new ConflictError('Challenge slug already exists');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.categoryIds) {
        const count = await tx.category.count({ where: { id: { in: input.categoryIds } } });
        if (count !== input.categoryIds.length) {
          throw new BadRequestError('One or more categoryIds are invalid');
        }
        await tx.challengeCategory.deleteMany({ where: { challengeId } });
        await tx.challengeCategory.createMany({
          data: input.categoryIds.map((categoryId) => ({ challengeId, categoryId })),
        });
      }

      if (input.tags) {
        const normalized = Array.from(
          new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
        );
        await tx.challengeTag.deleteMany({ where: { challengeId } });
        if (normalized.length > 0) {
          await tx.challengeTag.createMany({
            data: normalized.map((tag) => ({ challengeId, tag })),
          });
        }
      }

      return tx.challenge.update({
        where: { id: challengeId },
        data: {
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.connectionInfo !== undefined
            ? { connectionInfo: input.connectionInfo?.trim() || null }
            : {}),
          ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
          ...(input.challengeType !== undefined ? { challengeType: input.challengeType } : {}),
          ...(input.isVisible !== undefined ? { isVisible: input.isVisible } : {}),
          ...(input.scoringMode !== undefined ? { scoringMode: input.scoringMode } : {}),
          ...(input.points !== undefined ? { points: input.points } : {}),
          ...(input.initialPoints !== undefined ? { initialPoints: input.initialPoints } : {}),
          ...(input.minPoints !== undefined ? { minPoints: input.minPoints } : {}),
          ...(input.decayRate !== undefined ? { decayRate: input.decayRate } : {}),
          ...(input.firstBloodBonus !== undefined ? { firstBloodBonus: input.firstBloodBonus } : {}),
          ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
          ...(input.competitionId !== undefined ? { competitionId: input.competitionId } : {}),
          ...(input.authorId !== undefined && this.isPlatformAdmin(auth)
            ? { authorId: input.authorId }
            : {}),
        },
        select: PUBLIC_CHALLENGE_SELECT,
      });
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_UPDATED',
      entityType: 'Challenge',
      entityId: challengeId,
      ipAddress,
    });

    return { challenge: updated };
  }

  async transitionChallenge(
    auth: AuthenticatedContext,
    challengeId: string,
    targetStatus: ChallengeStatus,
    ipAddress?: string,
  ) {
    const existing = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { flagConfiguration: { select: { id: true } } },
    });
    if (!existing) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, existing);

    const currentStatus = existing.status as ChallengeStatus;
    const allowed = VALID_CHALLENGE_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new BadRequestError(
        `Invalid challenge lifecycle transition: ${currentStatus} -> ${targetStatus}`,
        'INVALID_TRANSITION',
      );
    }

    if (targetStatus === 'PUBLISHED') {
      if (!existing.flagConfiguration) {
        throw new BadRequestError(
          'Cannot publish a challenge without configuring a flag',
          'FLAG_REQUIRED_BEFORE_PUBLISH',
        );
      }
      if (existing.competitionId) {
        await this.assertCompetitionAssignmentAccess(auth, existing.competitionId);
      }
    }

    const updated = await this.prisma.challenge.update({
      where: { id: challengeId },
      data: {
        status: targetStatus,
        isVisible: targetStatus === 'PUBLISHED',
      },
      select: { id: true, slug: true, status: true, isVisible: true },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: targetStatus === 'PUBLISHED' ? 'CHALLENGE_PUBLISHED' : 'CHALLENGE_TRANSITIONED',
      entityType: 'Challenge',
      entityId: challengeId,
      metadata: { from: currentStatus, to: targetStatus },
      ipAddress,
    });

    return { challenge: updated };
  }

  async deleteChallenge(auth: AuthenticatedContext, challengeId: string, ipAddress?: string) {
    const existing = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: {
        id: true,
        slug: true,
        authorId: true,
        createdById: true,
        competitionId: true,
        _count: { select: { solves: true } },
      },
    });
    if (!existing) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, existing);

    if (existing._count.solves > 0) {
      throw new ConflictError(
        'Cannot delete a challenge with recorded solves; archive it instead',
        'CHALLENGE_HAS_SOLVES',
      );
    }

    await this.prisma.challenge.delete({ where: { id: challengeId } });

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_DELETED',
      entityType: 'Challenge',
      entityId: challengeId,
      metadata: { slug: existing.slug },
      ipAddress,
    });

    return { deleted: true };
  }

  async configureFlag(
    auth: AuthenticatedContext,
    challengeId: string,
    input: { flagType: FlagType; flagValue: string; dynamicPattern?: string },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, authorId: true, createdById: true, competitionId: true },
    });
    if (!existing) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, existing);

    const record = buildStoredFlagRecord(input, this.flagCrypto);

    const saved = await this.prisma.flagConfiguration.upsert({
      where: { challengeId },
      update: record,
      create: { challengeId, ...record },
      select: { id: true, flagType: true, dynamicPattern: true, updatedAt: true },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_FLAG_CONFIGURED',
      entityType: 'Challenge',
      entityId: challengeId,
      metadata: { flagType: input.flagType },
      ipAddress,
    });

    return { flagMetadata: saved };
  }

  async testFlag(
    auth: AuthenticatedContext,
    challengeId: string,
    input: { candidateFlag: string; participantKey?: string },
  ) {
    const existing = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      include: { flagConfiguration: true },
    });
    if (!existing) throw new NotFoundError('Challenge not found');
    await this.assertChallengeManageAccess(auth, existing);

    if (!existing.flagConfiguration) {
      throw new BadRequestError('Flag has not been configured for this challenge');
    }

    const valid = verifyCandidateFlag({
      stored: existing.flagConfiguration,
      candidateFlag: input.candidateFlag,
      challengeId: existing.id,
      participantKey: input.participantKey ?? auth.userId,
      cfg: this.flagCrypto,
    });

    return { valid };
  }
}
