import type { CompetitionStatus, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AchievementsService } from '../achievements/achievements.service.js';


const VALID_COMPETITION_TRANSITIONS: Record<CompetitionStatus, readonly CompetitionStatus[]> = {
  DRAFT: ['SCHEDULED', 'ARCHIVED'],
  SCHEDULED: ['REGISTRATION_OPEN', 'ARCHIVED'],
  REGISTRATION_OPEN: ['UPCOMING'],
  UPCOMING: ['LIVE', 'ARCHIVED'],
  LIVE: ['PAUSED', 'COMPLETED'],
  PAUSED: ['LIVE', 'COMPLETED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function computeCompetitionAvailability(
  comp: {
    status: string;
    registrationOpenAt: Date | null;
    registrationCloseAt: Date | null;
    startsAt: Date;
    endsAt: Date;
  },
  now = new Date(),
) {
  const nowMs = now.getTime();
  const regOpenMs = comp.registrationOpenAt?.getTime() ?? null;
  const regCloseMs = comp.registrationCloseAt?.getTime() ?? comp.startsAt.getTime();
  const startMs = comp.startsAt.getTime();
  const endMs = comp.endsAt.getTime();

  let registrationOpen = false;
  let registrationReason = 'Registration is closed.';

  if (comp.status === 'REGISTRATION_OPEN') {
    if (regOpenMs !== null && nowMs < regOpenMs) {
      registrationReason = 'Registration window has not opened yet.';
    } else if (nowMs >= regCloseMs) {
      registrationReason = 'Registration window has closed.';
    } else {
      registrationOpen = true;
      registrationReason = 'Registration is currently open.';
    }
  } else if (comp.status === 'DRAFT' || comp.status === 'SCHEDULED') {
    registrationReason = 'Registration has not opened yet.';
  } else if (comp.status === 'UPCOMING') {
    registrationReason = 'Registration has closed; awaiting competition start.';
  } else if (comp.status === 'PAUSED') {
    registrationReason = 'Competition is paused.';
  } else if (comp.status === 'COMPLETED' || comp.status === 'ARCHIVED') {
    registrationReason = 'Competition has ended.';
  }

  let submissionsOpen = false;
  let submissionReason = 'Submissions are closed.';
  if (comp.status === 'LIVE') {
    if (nowMs < startMs) {
      submissionReason = 'Competition has not reached its scheduled start time.';
    } else if (nowMs > endMs) {
      submissionReason = 'Competition end time has passed.';
    } else {
      submissionsOpen = true;
      submissionReason = 'Competition is LIVE and accepting flag submissions.';
    }
  } else if (comp.status === 'PAUSED') {
    submissionReason = 'Competition is temporarily PAUSED; submissions are suspended.';
  } else if (comp.status === 'COMPLETED' || comp.status === 'ARCHIVED') {
    submissionReason = 'Competition has concluded; scoreboard is read-only.';
  } else {
    submissionReason = `Submissions are unavailable while competition status is ${comp.status}.`;
  }

  return {
    registrationOpen,
    registrationReason,
    submissionsOpen,
    submissionReason,
    allowedTransitions: VALID_COMPETITION_TRANSITIONS[comp.status as CompetitionStatus] ?? [],
  };
}

export class CompetitionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly notifications?: NotificationsService,
    private readonly achievements?: AchievementsService,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext | null): boolean {
    if (!auth) return false;
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async hasManageAccess(
    auth: AuthenticatedContext | null,
    competition: { id: string; createdById: string },
  ): Promise<boolean> {
    if (!auth) return false;
    if (this.isPlatformAdmin(auth)) return true;
    if (!auth.roles.includes('COMPETITION_ORGANIZER')) return false;
    if (competition.createdById === auth.userId) return true;

    const assigned = await this.prisma.competitionOrganizer.findUnique({
      where: {
        competitionId_userId: { competitionId: competition.id, userId: auth.userId },
      },
    });
    return Boolean(assigned);
  }

  private async assertManageAccess(auth: AuthenticatedContext, competitionId: string) {
    const comp = await this.prisma.competition.findUnique({
      where: { id: competitionId },
    });
    if (!comp) throw new NotFoundError('Competition not found');
    const allowed = await this.hasManageAccess(auth, comp);
    if (!allowed) {
      throw new ForbiddenError('You are not authorized to manage this competition');
    }
    return comp;
  }

  async listPublicCompetitions(query: {
    search?: string;
    status?: string;
    phase?: 'ALL' | 'LIVE' | 'REGISTRATION_OPEN' | 'UPCOMING' | 'COMPLETED';
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const search = query.search?.trim();

    let statusFilter: any = { not: 'DRAFT' };
    if (query.status) {
      statusFilter = { equals: query.status, not: 'DRAFT' };
    } else if (query.phase === 'LIVE') {
      statusFilter = { equals: 'LIVE' };
    } else if (query.phase === 'REGISTRATION_OPEN') {
      statusFilter = { equals: 'REGISTRATION_OPEN' };
    } else if (query.phase === 'UPCOMING') {
      statusFilter = { in: ['SCHEDULED', 'REGISTRATION_OPEN', 'UPCOMING'] };
    } else if (query.phase === 'COMPLETED') {
      statusFilter = { in: ['COMPLETED', 'ARCHIVED'] };
    }

    const where: any = {
      isVisible: true,
      status: statusFilter,
      ...(search
        ? { OR: [{ title: { contains: search } }, { description: { contains: search } }] }
        : {}),
    };
    // ...keep existing findMany, count, and pagination mapping unchanged

    const [competitions, total] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          bannerUrl: true,
          status: true,
          timezone: true,
          participationMode: true,
          minTeamSize: true,
          maxTeamSize: true,
          scoringMode: true,
          registrationOpenAt: true,
          registrationCloseAt: true,
          startsAt: true,
          endsAt: true,
          _count: {
            select: {
              registrations: true,
              teams: true,
              challenges: { where: { status: 'PUBLISHED', isVisible: true } },
            },
          },
        },
      }),
      this.prisma.competition.count({ where }),
    ]);

    return {
      competitions: competitions.map((c) => ({
        ...c,
        participantCount: c._count.registrations,
        teamCount: c._count.teams,
        challengeCount: c._count.challenges,
        _count: undefined,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getPublicCompetitionBySlug(slug: string, auth: AuthenticatedContext | null) {
    const comp = await this.prisma.competition.findUnique({
      where: { slug },
      include: {
        createdBy: { select: { id: true, username: true, displayName: true } },
        organizers: {
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
        },
        _count: {
          select: {
            registrations: true,
            teams: true,
            challenges: { where: { status: 'PUBLISHED', isVisible: true } },
            announcements: true,
          },
        },
      },
    });

    if (!comp) throw new NotFoundError('Competition not found');

    if ((!comp.isVisible || comp.status === 'DRAFT') && !(await this.hasManageAccess(auth, comp))) {
      throw new NotFoundError('Competition not found');
    }

    return {
      competition: {
        id: comp.id,
        slug: comp.slug,
        title: comp.title,
        description: comp.description,
        bannerUrl: comp.bannerUrl,
        rules: comp.rules,
        status: comp.status,
        isVisible: comp.isVisible,
        timezone: comp.timezone,
        participationMode: comp.participationMode,
        minTeamSize: comp.minTeamSize,
        maxTeamSize: comp.maxTeamSize,
        lockTeamRosterOnLive: comp.lockTeamRosterOnLive,
        scoringMode: comp.scoringMode,
        dynamicScoringPolicy: comp.dynamicScoringPolicy,
        allowNegativeScores: comp.allowNegativeScores,
        firstBloodEnabled: comp.firstBloodEnabled,
        registrationOpenAt: comp.registrationOpenAt,
        registrationCloseAt: comp.registrationCloseAt,
        startsAt: comp.startsAt,
        endsAt: comp.endsAt,
        organizers: comp.organizers.map((o) => o.user),
        participantCount: comp._count.registrations,
        teamCount: comp._count.teams,
        challengeCount: comp._count.challenges,
        announcementCount: comp._count.announcements,
        lifecycle: computeCompetitionAvailability(comp),
        createdAt: comp.createdAt,
        updatedAt: comp.updatedAt,
      },
    };
  }

  async listAdminCompetitions(auth: AuthenticatedContext) {
    const isAdmin = this.isPlatformAdmin(auth);
    const competitions = await this.prisma.competition.findMany({
      where: isAdmin
        ? {}
        : {
            OR: [
              { createdById: auth.userId },
              { organizers: { some: { userId: auth.userId } } },
            ],
          },
      orderBy: { updatedAt: 'desc' },
      include: {
        organizers: {
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
        _count: {
          select: { registrations: true, teams: true, challenges: true },
        },
      },
    });

    return { competitions };
  }

  async getAdminCompetitionById(auth: AuthenticatedContext, competitionId: string) {
    await this.assertManageAccess(auth, competitionId);
    const comp = await this.prisma.competition.findUniqueOrThrow({
      where: { id: competitionId },
      include: {
        organizers: {
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
        _count: {
          select: { registrations: true, teams: true, challenges: true, solves: true },
        },
      },
    });
    return { competition: comp };
  }

  async createCompetition(
    auth: AuthenticatedContext,
    input: {
      slug: string;
      title: string;
      description: string;
      rules: string;
      bannerUrl?: string | null;
      isVisible: boolean;
      timezone: string;
      participationMode: string;
      minTeamSize: number;
      maxTeamSize: number;
      lockTeamRosterOnLive: boolean;
      scoringMode: string;
      dynamicScoringPolicy: string;
      allowNegativeScores: boolean;
      firstBloodEnabled: boolean;
      registrationOpenAt?: string | null;
      registrationCloseAt?: string | null;
      startsAt: string;
      endsAt: string;
    },
    ipAddress?: string,
  ) {
    const existingSlug = await this.prisma.competition.findUnique({ where: { slug: input.slug } });
    if (existingSlug) throw new ConflictError('Competition slug already exists');

    const competition = await this.prisma.$transaction(async (tx) => {
      const created = await tx.competition.create({
        data: {
          slug: input.slug,
          title: input.title,
          description: input.description,
          rules: input.rules,
          bannerUrl: input.bannerUrl ?? null,
          status: 'DRAFT',
          isVisible: input.isVisible,
          timezone: input.timezone,
          participationMode: input.participationMode,
          minTeamSize: input.minTeamSize,
          maxTeamSize: input.maxTeamSize,
          lockTeamRosterOnLive: input.lockTeamRosterOnLive,
          scoringMode: input.scoringMode,
          dynamicScoringPolicy: input.dynamicScoringPolicy,
          allowNegativeScores: input.allowNegativeScores,
          firstBloodEnabled: input.firstBloodEnabled,
          registrationOpenAt: input.registrationOpenAt ? new Date(input.registrationOpenAt) : null,
          registrationCloseAt: input.registrationCloseAt ? new Date(input.registrationCloseAt) : null,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          createdById: auth.userId,
        },
      });

      await tx.competitionOrganizer.create({
        data: {
          competitionId: created.id,
          userId: auth.userId,
          assignedById: auth.userId,
        },
      });

      return created;
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_CREATED',
      entityType: 'Competition',
      entityId: competition.id,
      metadata: { slug: competition.slug, timezone: competition.timezone },
      ipAddress,
    });

    return { competition };
  }

  async updateCompetition(
    auth: AuthenticatedContext,
    competitionId: string,
    input: {
      slug?: string;
      title?: string;
      description?: string;
      rules?: string;
      bannerUrl?: string | null;
      isVisible?: boolean;
      timezone?: string;
      participationMode?: string;
      minTeamSize?: number;
      maxTeamSize?: number;
      lockTeamRosterOnLive?: boolean;
      scoringMode?: string;
      dynamicScoringPolicy?: string;
      allowNegativeScores?: boolean;
      firstBloodEnabled?: boolean;
      registrationOpenAt?: string | null;
      registrationCloseAt?: string | null;
      startsAt?: string;
      endsAt?: string;
    },
    ipAddress?: string,
  ) {
    const existing = await this.assertManageAccess(auth, competitionId);

    if (existing.status === 'COMPLETED' || existing.status === 'ARCHIVED') {
      throw new ConflictError('Completed or archived competitions are read-only', 'COMPETITION_IMMUTABLE');
    }
    if (existing.status === 'LIVE' || existing.status === 'PAUSED') {
      if (input.participationMode || input.scoringMode || input.startsAt) {
        throw new ConflictError(
          'Cannot alter mode or start time while competition is LIVE or PAUSED',
          'COMPETITION_LOCKED_FIELDS',
        );
      }
    }

    if (input.slug && input.slug !== existing.slug) {
      const conflict = await this.prisma.competition.findUnique({ where: { slug: input.slug } });
      if (conflict) throw new ConflictError('Competition slug already exists');
    }

    const nextMinTeam = input.minTeamSize ?? existing.minTeamSize;
    const nextMaxTeam = input.maxTeamSize ?? existing.maxTeamSize;
    if (nextMaxTeam < nextMinTeam) {
      throw new BadRequestError('maxTeamSize must be greater than or equal to minTeamSize');
    }

    const nextStart = input.startsAt ? new Date(input.startsAt) : existing.startsAt;
    const nextEnd = input.endsAt ? new Date(input.endsAt) : existing.endsAt;
    if (nextEnd.getTime() <= nextStart.getTime()) {
      throw new BadRequestError('endsAt must be after startsAt');
    }

    const nextRegOpen =
      input.registrationOpenAt !== undefined
        ? input.registrationOpenAt
          ? new Date(input.registrationOpenAt)
          : null
        : existing.registrationOpenAt;
    const nextRegClose =
      input.registrationCloseAt !== undefined
        ? input.registrationCloseAt
          ? new Date(input.registrationCloseAt)
          : null
        : existing.registrationCloseAt;

    if (nextRegOpen && nextRegClose && nextRegClose.getTime() <= nextRegOpen.getTime()) {
      throw new BadRequestError('registrationCloseAt must be after registrationOpenAt');
    }
    if (nextRegClose && nextRegClose.getTime() > nextEnd.getTime()) {
      throw new BadRequestError('registrationCloseAt cannot be after endsAt');
    }

    // Prevent shrinking maxTeamSize below already-registered team member counts
    if (input.maxTeamSize !== undefined && input.maxTeamSize < existing.maxTeamSize) {
      const regTeams = await this.prisma.competitionTeam.findMany({
        where: { competitionId, status: 'CONFIRMED' },
        include: { team: { select: { _count: { select: { members: true } } } } },
      });
      if (regTeams.some((rt) => rt.team._count.members > nextMaxTeam)) {
        throw new ConflictError(
          'Cannot lower maxTeamSize below an already-registered team member count',
        );
      }
    }

    const updated = await this.prisma.competition.update({
      where: { id: competitionId },
      data: {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.rules !== undefined ? { rules: input.rules } : {}),
        ...(input.bannerUrl !== undefined ? { bannerUrl: input.bannerUrl } : {}),
        ...(input.isVisible !== undefined ? { isVisible: input.isVisible } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.participationMode !== undefined ? { participationMode: input.participationMode } : {}),
        minTeamSize: nextMinTeam,
        maxTeamSize: nextMaxTeam,
        ...(input.lockTeamRosterOnLive !== undefined ? { lockTeamRosterOnLive: input.lockTeamRosterOnLive } : {}),
        ...(input.scoringMode !== undefined ? { scoringMode: input.scoringMode } : {}),
        ...(input.dynamicScoringPolicy !== undefined ? { dynamicScoringPolicy: input.dynamicScoringPolicy } : {}),
        ...(input.allowNegativeScores !== undefined ? { allowNegativeScores: input.allowNegativeScores } : {}),
        ...(input.firstBloodEnabled !== undefined ? { firstBloodEnabled: input.firstBloodEnabled } : {}),
        registrationOpenAt: nextRegOpen,
        registrationCloseAt: nextRegClose,
        startsAt: nextStart,
        endsAt: nextEnd,
      },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_UPDATED',
      entityType: 'Competition',
      entityId: competitionId,
      ipAddress,
    });

    return { competition: updated };
  }

  async publishCompetition(auth: AuthenticatedContext, competitionId: string, ipAddress?: string) {
    const existing = await this.assertManageAccess(auth, competitionId);
    if (existing.status === 'DRAFT') {
      return this.transitionCompetition(auth, competitionId, 'SCHEDULED', 'Published competition', ipAddress);
    }
    const updated = await this.prisma.competition.update({
      where: { id: competitionId },
      data: { isVisible: true },
    });
    return { competition: updated };
  }

  async archiveCompetition(auth: AuthenticatedContext, competitionId: string, ipAddress?: string) {
    return this.transitionCompetition(auth, competitionId, 'ARCHIVED', 'Archived competition', ipAddress);
  }

  async deleteCompetition(auth: AuthenticatedContext, competitionId: string, ipAddress?: string) {
    const existing = await this.assertManageAccess(auth, competitionId);

    const [regCount, solveCount] = await Promise.all([
      this.prisma.competitionRegistration.count({ where: { competitionId } }),
      this.prisma.solve.count({ where: { competitionId } }),
    ]);

    if (existing.status !== 'DRAFT' || regCount > 0 || solveCount > 0) {
      throw new ConflictError(
        'Only empty DRAFT competitions can be deleted; archive active or historical competitions instead',
        'COMPETITION_CANNOT_DELETE',
      );
    }

    await this.prisma.competition.delete({ where: { id: competitionId } });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_DELETED',
      entityType: 'Competition',
      entityId: competitionId,
      metadata: { slug: existing.slug },
      ipAddress,
    });

    return { deleted: true };
  }

  async assignOrganizer(
    auth: AuthenticatedContext,
    competitionId: string,
    targetUserId: string,
    ipAddress?: string,
  ) {
    await this.assertManageAccess(auth, competitionId);

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roles: { include: { role: true } } },
    });
    if (!target || target.deletedAt || target.accountStatus !== 'ACTIVE') {
      throw new NotFoundError('Target user not found');
    }

    const allowedRoles = new Set(['SUPER_ADMIN', 'PLATFORM_ADMIN', 'COMPETITION_ORGANIZER']);
    const hasStaffRole = target.roles.some((r) => allowedRoles.has(r.role.name));
    if (!hasStaffRole) {
      throw new BadRequestError(
        'Assigned manager must hold COMPETITION_ORGANIZER or Admin role',
      );
    }

    await this.prisma.competitionOrganizer.upsert({
      where: { competitionId_userId: { competitionId, userId: targetUserId } },
      update: {},
      create: {
        competitionId,
        userId: targetUserId,
        assignedById: auth.userId,
      },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_ORGANIZER_ASSIGNED',
      entityType: 'Competition',
      entityId: competitionId,
      metadata: { targetUserId },
      ipAddress,
    });

    return { assigned: true, userId: targetUserId };
  }

  async removeOrganizer(
    auth: AuthenticatedContext,
    competitionId: string,
    targetUserId: string,
    ipAddress?: string,
  ) {
    const comp = await this.assertManageAccess(auth, competitionId);
    if (comp.createdById === targetUserId) {
      throw new BadRequestError('Cannot remove the primary competition creator');
    }

    await this.prisma.competitionOrganizer.deleteMany({
      where: { competitionId, userId: targetUserId },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_ORGANIZER_REMOVED',
      entityType: 'Competition',
      entityId: competitionId,
      metadata: { targetUserId },
      ipAddress,
    });

    return { removed: true };
  }

  async executeLifecycleTransition(params: {
    competitionId: string;
    targetStatus: CompetitionStatus;
    actorId: string | null; // null = SYSTEM_SCHEDULER
    reason?: string;
    ipAddress?: string;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const nowMs = now.getTime();

    const updated = await this.prisma.$transaction(async (tx) => {
      const comp = await tx.competition.findUnique({
        where: { id: params.competitionId },
      });
      if (!comp) throw new NotFoundError('Competition not found');

      const currentStatus = comp.status as CompetitionStatus;
      const allowed = VALID_COMPETITION_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(params.targetStatus)) {
        throw new BadRequestError(
          `Invalid competition transition: ${currentStatus} -> ${params.targetStatus}`,
          'INVALID_TRANSITION',
        );
      }

      // Enforce time-window and schedule invariants
      if (params.targetStatus === 'SCHEDULED') {
        if (comp.endsAt.getTime() <= comp.startsAt.getTime()) {
          throw new BadRequestError('Competition endsAt must be after startsAt');
        }
        if (comp.startsAt.getTime() <= nowMs) {
          throw new BadRequestError('Cannot schedule a competition whose startsAt is in the past');
        }
      }

      if (params.targetStatus === 'REGISTRATION_OPEN') {
        if (comp.registrationOpenAt && nowMs < comp.registrationOpenAt.getTime()) {
          throw new BadRequestError(
            'Cannot open registration before configured registrationOpenAt',
            'REGISTRATION_WINDOW_NOT_STARTED',
          );
        }
        const regCloseMs = comp.registrationCloseAt?.getTime() ?? comp.startsAt.getTime();
        if (nowMs >= regCloseMs) {
          throw new BadRequestError(
            'Cannot open registration after registrationCloseAt / startsAt',
            'REGISTRATION_WINDOW_EXPIRED',
          );
        }
      }

      if (params.targetStatus === 'LIVE') {
        if (nowMs < comp.startsAt.getTime()) {
          throw new BadRequestError(
            'Cannot transition to LIVE before competition startsAt',
            'COMPETITION_NOT_STARTED',
          );
        }
        if (nowMs >= comp.endsAt.getTime()) {
          throw new BadRequestError(
            'Cannot transition to LIVE after competition endsAt',
            'COMPETITION_ALREADY_ENDED',
          );
        }
      }

      const patchData: Record<string, unknown> = {
        status: params.targetStatus,
        version: { increment: 1 },
      };

      if (params.targetStatus === 'SCHEDULED') {
        patchData.isVisible = true;
      } else if (params.targetStatus === 'PAUSED') {
        patchData.pausedAt = now;
      } else if (params.targetStatus === 'COMPLETED') {
        patchData.completedAt = now;
      } else if (params.targetStatus === 'ARCHIVED') {
        patchData.archivedAt = now;
      }

      // Optimistic concurrency lock prevents duplicate transitions under parallel requests
      const cas = await tx.competition.updateMany({
        where: {
          id: comp.id,
          status: currentStatus,
          version: comp.version,
        },
        data: patchData,
      });

      if (cas.count !== 1) {
        throw new ConflictError(
          'Competition state was modified concurrently; refresh and retry',
          'CONCURRENT_TRANSITION',
        );
      }

      const next = await tx.competition.findUniqueOrThrow({ where: { id: comp.id } });

      await tx.auditLog.create({
        data: {
          actorId: params.actorId,
          action: 'COMPETITION_LIFECYCLE_TRANSITION',
          entityType: 'Competition',
          entityId: comp.id,
          metadata: JSON.stringify({
            competitionId: comp.id,
            previousStatus: currentStatus,
            newStatus: params.targetStatus,
            actorType: params.actorId ? 'ORGANIZER' : 'SYSTEM_SCHEDULER',
            reason: params.reason ?? null,
            timestamp: now.toISOString(),
          }),
          ipAddress: params.ipAddress ?? null,
        },
      });

      return { previousStatus: currentStatus, competition: next };
    });

    if (params.targetStatus === 'COMPLETED') {
      await this.achievements?.evaluateOnCompetitionCompleted(params.competitionId);
    }
    if (params.targetStatus === 'LIVE') {
      await this.notifications?.notifyCompetitionParticipants({
        competitionId: params.competitionId,
        type: 'COMP_LIVE',
        title: `${updated.competition.title} is now LIVE`,
        message: 'The competition has started. Challenges are now open for flag submission.',
        linkUrl: `/competitions/${updated.competition.slug}/challenges`,
        dedupeKey: `comp_live:${params.competitionId}`,
      });
    }
    if (params.targetStatus === 'COMPLETED') {
      await this.notifications?.notifyCompetitionParticipants({
        competitionId: params.competitionId,
        type: 'COMP_END',
        title: `${updated.competition.title} has completed`,
        message: 'The competition window has ended and final standings are available.',
        linkUrl: `/competitions/${updated.competition.slug}/leaderboard`,
        dedupeKey: `comp_end:${params.competitionId}`,
      });
    }

    return updated;
  }

  async transitionCompetition(
    auth: AuthenticatedContext,
    competitionId: string,
    targetStatus: CompetitionStatus,
    reason?: string,
    ipAddress?: string,
    now?: Date,
  ) {
    await this.assertManageAccess(auth, competitionId);
    return this.executeLifecycleTransition({
      competitionId,
      targetStatus,
      actorId: auth.userId,
      reason,
      ipAddress,
      now,
    });
  }

  async listPublicAnnouncements(slug: string, auth: AuthenticatedContext | null) {
    const comp = await this.prisma.competition.findUnique({
      where: { slug },
      select: { id: true, status: true, isVisible: true, createdById: true },
    });
    if (!comp) throw new NotFoundError('Competition not found');

    if ((!comp.isVisible || comp.status === 'DRAFT') && !(await this.hasManageAccess(auth, comp))) {
      throw new NotFoundError('Competition not found');
    }

    const announcements = await this.prisma.announcement.findMany({
      where: { competitionId: comp.id },
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
      select: {
        id: true,
        title: true,
        body: true,
        isPinned: true,
        publishedAt: true,
        author: { select: { username: true, displayName: true } },
      },
    });

    return { announcements };
  }
}
