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
import type { NotificationsService } from '../notifications/notifications.service.js';

function isUniqueOrRaceError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  if (code === 'P2002' || code === 'P2034') return true;
  const msg = (err as { message?: string }).message ?? '';
  return msg.includes('UNIQUE constraint failed') || msg.includes('SQLITE_BUSY');
}

export class RegistrationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly notifications?: NotificationsService,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async assertManageAccess(auth: AuthenticatedContext, competitionId: string) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');
    if (this.isPlatformAdmin(auth)) return comp;
    if (auth.roles.includes('COMPETITION_ORGANIZER')) {
      if (comp.createdById === auth.userId) return comp;
      const assigned = await this.prisma.competitionOrganizer.findUnique({
        where: { competitionId_userId: { competitionId, userId: auth.userId } },
      });
      if (assigned) return comp;
    }
    throw new ForbiddenError('Not authorized to manage registrations for this competition');
  }

  private assertRegistrationWindowOpen(
    comp: {
      status: string;
      isVisible: boolean;
      registrationOpenAt: Date | null;
      registrationCloseAt: Date | null;
      startsAt: Date;
    },
    now = new Date(),
  ): void {
    if (!comp.isVisible || comp.status !== 'REGISTRATION_OPEN') {
      throw new ForbiddenError(
        `Registration is not open (competition status: ${comp.status})`,
        'REGISTRATION_CLOSED',
      );
    }
    const nowMs = now.getTime();
    if (comp.registrationOpenAt && nowMs < comp.registrationOpenAt.getTime()) {
      throw new ForbiddenError('Registration window has not opened yet', 'REGISTRATION_NOT_OPEN');
    }
    const closeMs = comp.registrationCloseAt?.getTime() ?? comp.startsAt.getTime();
    if (nowMs >= closeMs) {
      throw new ForbiddenError('Registration window has closed', 'REGISTRATION_CLOSED');
    }
  }

  private evaluateCancellationAllowed(
    comp: {
      status: string;
      allowRegistrationCancel: boolean;
      cancellationCutoffAt: Date | null;
      registrationCloseAt: Date | null;
      startsAt: Date;
    },
    now = new Date(),
  ): { allowed: boolean; reason: string } {
    if (!comp.allowRegistrationCancel) {
      return { allowed: false, reason: 'Competition rules prohibit registration cancellation.' };
    }
    if (comp.status !== 'REGISTRATION_OPEN' && comp.status !== 'UPCOMING') {
      return {
        allowed: false,
        reason: `Cancellation is unavailable while competition status is ${comp.status}.`,
      };
    }
    const cutoff = comp.cancellationCutoffAt ?? comp.registrationCloseAt ?? comp.startsAt;
    if (now.getTime() >= cutoff.getTime()) {
      return { allowed: false, reason: 'Cancellation cutoff deadline has passed.' };
    }
    return { allowed: true, reason: 'Cancellation permitted prior to cutoff.' };
  }

  async registerIndividual(
    auth: AuthenticatedContext,
    competitionId: string,
    ipAddress?: string,
    now = new Date(),
  ) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    this.assertRegistrationWindowOpen(comp, now);

    if (comp.participationMode === 'TEAM') {
      throw new BadRequestError(
        'This competition requires team registration',
        'TEAM_REGISTRATION_REQUIRED',
      );
    }

    let registration;
    try {
      registration = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.competitionRegistration.findUnique({
          where: { competitionId_userId: { competitionId, userId: auth.userId } },
        });

        if (existing?.status === 'DISQUALIFIED') {
          throw new ForbiddenError('You are disqualified from this competition', 'DISQUALIFIED');
        }
        if (existing?.status === 'CONFIRMED') {
          throw new ConflictError('You are already registered for this competition', 'ALREADY_REGISTERED');
        }

        let saved;
        if (existing?.status === 'WITHDRAWN') {
          const cas = await tx.competitionRegistration.updateMany({
            where: { id: existing.id, status: 'WITHDRAWN' },
            data: {
              status: 'CONFIRMED',
              teamId: null,
              registeredById: auth.userId,
              registeredAt: now,
              cancelledAt: null,
            },
          });
          if (cas.count !== 1) {
            throw new ConflictError('Duplicate registration attempt detected', 'ALREADY_REGISTERED');
          }
          saved = await tx.competitionRegistration.findUniqueOrThrow({ where: { id: existing.id } });
        } else {
          saved = await tx.competitionRegistration.create({
            data: {
              competitionId,
              userId: auth.userId,
              teamId: null,
              status: 'CONFIRMED',
              registeredById: auth.userId,
              registeredAt: now,
            },
          });
        }

        await tx.registrationEvent.create({
          data: {
            competitionId,
            userId: auth.userId,
            action: 'REGISTERED',
            actorId: auth.userId,
            reason: 'Individual registration',
          },
        });

        return saved;
      });
    } catch (err) {
      if (err instanceof ConflictError || err instanceof ForbiddenError) throw err;
      if (isUniqueOrRaceError(err)) {
        throw new ConflictError('Already registered for this competition', 'ALREADY_REGISTERED');
      }
      throw err;
    }

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_REGISTERED_INDIVIDUAL',
      entityType: 'CompetitionRegistration',
      entityId: registration.id,
      metadata: { competitionId },
      ipAddress,
    });

    if (this.notifications) {
      await this.notifications.dispatchToUsers({
        userIds: [auth.userId],
        type: 'COMP_REG',
        title: `Registration confirmed: ${comp.title}`,
        message: 'Your registration for this competition has been confirmed.',
        linkUrl: `/competitions/${comp.slug}`,
        dedupeKey: `comp_reg:${comp.id}:${now.getTime()}`,
        sendEmail: true,
      });
    }

    return { registration };
  }

  async registerTeam(
    auth: AuthenticatedContext,
    competitionId: string,
    teamId: string,
    ipAddress?: string,
    now = new Date(),
  ) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    this.assertRegistrationWindowOpen(comp, now);

    if (comp.participationMode === 'INDIVIDUAL') {
      throw new BadRequestError(
        'This competition only allows individual registration',
        'INDIVIDUAL_REGISTRATION_ONLY',
      );
    }

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const team = await tx.team.findFirst({
          where: { id: teamId, deletedAt: null },
          include: {
            members: {
              include: {
                user: { select: { id: true, username: true, accountStatus: true, deletedAt: true } },
              },
            },
          },
        });
        if (!team) throw new NotFoundError('Team not found');

        if (team.captainId !== auth.userId) {
          throw new ForbiddenError('Only the team captain can register the team for competitions');
        }

        const memberCount = team.members.length;
        if (memberCount < comp.minTeamSize || memberCount > comp.maxTeamSize) {
          throw new BadRequestError(
            `Team size (${memberCount}) must be between ${comp.minTeamSize} and ${comp.maxTeamSize}`,
            'TEAM_SIZE_OUT_OF_BOUNDS',
          );
        }

        for (const m of team.members) {
          if (m.user.accountStatus !== 'ACTIVE' || m.user.deletedAt) {
            throw new BadRequestError(
              `Team member @${m.user.username} is not an active eligible account`,
              'INELIGIBLE_MEMBER',
            );
          }
        }

        const existingTeamReg = await tx.competitionTeam.findUnique({
          where: { competitionId_teamId: { competitionId, teamId } },
        });
        if (existingTeamReg?.status === 'DISQUALIFIED') {
          throw new ForbiddenError('This team is disqualified from the competition', 'DISQUALIFIED');
        }
        if (existingTeamReg?.status === 'CONFIRMED') {
          throw new ConflictError('Team is already registered for this competition', 'ALREADY_REGISTERED');
        }

        const memberUserIds = team.members.map((m) => m.userId);
        const existingMemberRegs = await tx.competitionRegistration.findMany({
          where: { competitionId, userId: { in: memberUserIds } },
        });
        const regByUserId = new Map(existingMemberRegs.map((r) => [r.userId, r]));

        for (const m of team.members) {
          const prior = regByUserId.get(m.userId);
          if (prior?.status === 'DISQUALIFIED') {
            throw new ForbiddenError(
              `Member @${m.user.username} is disqualified from this competition`,
              'DISQUALIFIED',
            );
          }
          if (prior?.status === 'CONFIRMED') {
            throw new ConflictError(
              `Member @${m.user.username} is already registered in this competition`,
              'MEMBER_ALREADY_REGISTERED',
            );
          }
        }

        let compTeam;
        if (existingTeamReg?.status === 'WITHDRAWN') {
          const cas = await tx.competitionTeam.updateMany({
            where: { id: existingTeamReg.id, status: 'WITHDRAWN' },
            data: {
              status: 'CONFIRMED',
              registeredById: auth.userId,
              registeredAt: now,
              cancelledAt: null,
            },
          });
          if (cas.count !== 1) {
            throw new ConflictError('Concurrent team registration detected', 'ALREADY_REGISTERED');
          }
          compTeam = await tx.competitionTeam.findUniqueOrThrow({ where: { id: existingTeamReg.id } });
        } else {
          compTeam = await tx.competitionTeam.create({
            data: {
              competitionId,
              teamId,
              status: 'CONFIRMED',
              registeredById: auth.userId,
              registeredAt: now,
            },
          });
        }

        for (const m of team.members) {
          const prior = regByUserId.get(m.userId);
          if (prior?.status === 'WITHDRAWN') {
            await tx.competitionRegistration.update({
              where: { id: prior.id },
              data: {
                status: 'CONFIRMED',
                teamId,
                registeredById: auth.userId,
                registeredAt: now,
                cancelledAt: null,
              },
            });
          } else {
            await tx.competitionRegistration.create({
              data: {
                competitionId,
                userId: m.userId,
                teamId,
                status: 'CONFIRMED',
                registeredById: auth.userId,
                registeredAt: now,
              },
            });
          }

          await tx.registrationEvent.create({
            data: {
              competitionId,
              userId: m.userId,
              teamId,
              action: 'REGISTERED',
              actorId: auth.userId,
              reason: `Registered via team ${team.name}`,
            },
          });
        }

        return { competitionTeam: compTeam, registeredMemberCount: memberCount, memberUserIds };
      });
    } catch (err) {
      if (
        err instanceof ConflictError ||
        err instanceof ForbiddenError ||
        err instanceof BadRequestError ||
        err instanceof NotFoundError
      ) {
        throw err;
      }
      if (isUniqueOrRaceError(err)) {
        throw new ConflictError(
          'Team or member is already registered for this competition',
          'ALREADY_REGISTERED',
        );
      }
      throw err;
    }

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_REGISTERED_TEAM',
      entityType: 'CompetitionTeam',
      entityId: result.competitionTeam.id,
      metadata: { competitionId, teamId, memberCount: result.registeredMemberCount },
      ipAddress,
    });

    if (this.notifications) {
      await this.notifications.dispatchToUsers({
        userIds: result.memberUserIds,
        type: 'COMP_REG',
        title: `Team registration confirmed: ${comp.title}`,
        message: 'Your team registration for this competition has been confirmed.',
        linkUrl: `/competitions/${comp.slug}`,
        dedupeKey: `comp_reg:${comp.id}:${teamId}:${now.getTime()}`,
        sendEmail: true,
      });
    }

    return result;
  }

  async cancelRegistration(
    auth: AuthenticatedContext,
    competitionId: string,
    ipAddress?: string,
    now = new Date(),
  ) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    const cancelPolicy = this.evaluateCancellationAllowed(comp, now);
    if (!cancelPolicy.allowed) {
      throw new ForbiddenError(cancelPolicy.reason, 'CANCELLATION_NOT_ALLOWED');
    }

    const reg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId, userId: auth.userId } },
    });
    if (!reg || reg.status !== 'CONFIRMED') {
      throw new NotFoundError('No active registration found to cancel');
    }

    if (!reg.teamId) {
      await this.prisma.$transaction(async (tx) => {
        const cas = await tx.competitionRegistration.updateMany({
          where: { id: reg.id, status: 'CONFIRMED' },
          data: { status: 'WITHDRAWN', cancelledAt: now },
        });
        if (cas.count !== 1) {
          throw new ConflictError('Registration already modified', 'CONCURRENT_MODIFICATION');
        }
        await tx.registrationEvent.create({
          data: {
            competitionId,
            userId: auth.userId,
            action: 'CANCELLED',
            actorId: auth.userId,
            reason: 'Individual registration cancelled',
          },
        });
      });

      await this.audit.record({
        actorId: auth.userId,
        action: 'COMPETITION_REGISTRATION_CANCELLED',
        entityType: 'CompetitionRegistration',
        entityId: reg.id,
        metadata: { competitionId },
        ipAddress,
      });

      return { cancelled: true, mode: 'INDIVIDUAL' as const };
    }

    const team = await this.prisma.team.findUnique({ where: { id: reg.teamId } });
    if (!team || team.captainId !== auth.userId) {
      throw new ForbiddenError(
        'Only the team captain can cancel a team competition registration',
        'CAPTAIN_REQUIRED',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const cas = await tx.competitionTeam.updateMany({
        where: { competitionId, teamId: team.id, status: 'CONFIRMED' },
        data: { status: 'WITHDRAWN', cancelledAt: now },
      });
      if (cas.count !== 1) {
        throw new ConflictError('Team registration already modified', 'CONCURRENT_MODIFICATION');
      }

      const teamRegs = await tx.competitionRegistration.findMany({
        where: { competitionId, teamId: team.id, status: 'CONFIRMED' },
      });

      await tx.competitionRegistration.updateMany({
        where: { competitionId, teamId: team.id, status: 'CONFIRMED' },
        data: { status: 'WITHDRAWN', cancelledAt: now },
      });

      for (const memberReg of teamRegs) {
        await tx.registrationEvent.create({
          data: {
            competitionId,
            userId: memberReg.userId,
            teamId: team.id,
            action: 'CANCELLED',
            actorId: auth.userId,
            reason: 'Team registration cancelled by captain',
          },
        });
      }
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_TEAM_REGISTRATION_CANCELLED',
      entityType: 'CompetitionTeam',
      entityId: `${competitionId}:${team.id}`,
      metadata: { competitionId, teamId: team.id },
      ipAddress,
    });

    return { cancelled: true, mode: 'TEAM' as const };
  }

  async getMyRegistrationStatus(auth: AuthenticatedContext, competitionId: string, now = new Date()) {
    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    const reg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId, userId: auth.userId } },
    });

    let teamInfo: { id: string; name: string; slug: string; isCaptain: boolean } | null = null;
    if (reg?.teamId) {
      const team = await this.prisma.team.findUnique({
        where: { id: reg.teamId },
        select: { id: true, name: true, slug: true, captainId: true },
      });
      if (team) {
        teamInfo = {
          id: team.id,
          name: team.name,
          slug: team.slug,
          isCaptain: team.captainId === auth.userId,
        };
      }
    }

    const captainedTeams = await this.prisma.team.findMany({
      where: { captainId: auth.userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { members: true } },
      },
    });

    const history = await this.prisma.registrationEvent.findMany({
      where: { competitionId, userId: auth.userId },
      orderBy: { createdAt: 'desc' },
    });

    let windowOpen = false;
    try {
      this.assertRegistrationWindowOpen(comp, now);
      windowOpen = true;
    } catch {
      windowOpen = false;
    }

    const cancelPolicy = this.evaluateCancellationAllowed(comp, now);
    const isRegistered = reg?.status === 'CONFIRMED';
    const canCancel = isRegistered && cancelPolicy.allowed && (!teamInfo || teamInfo.isCaptain);

    let cancelReason = cancelPolicy.reason;
    if (isRegistered && teamInfo && !teamInfo.isCaptain) {
      cancelReason = 'Only your Team Captain can cancel the team registration.';
    }

    return {
      status: reg?.status ?? 'NOT_REGISTERED',
      mode: reg?.teamId ? 'TEAM' : reg ? 'INDIVIDUAL' : null,
      team: teamInfo,
      registeredAt: reg?.registeredAt ?? null,
      cancelledAt: reg?.cancelledAt ?? null,
      windowOpen,
      canRegisterIndividual:
        windowOpen &&
        !isRegistered &&
        reg?.status !== 'DISQUALIFIED' &&
        (comp.participationMode === 'INDIVIDUAL' || comp.participationMode === 'HYBRID'),
      canRegisterTeam:
        windowOpen &&
        !isRegistered &&
        reg?.status !== 'DISQUALIFIED' &&
        (comp.participationMode === 'TEAM' || comp.participationMode === 'HYBRID'),
      eligibleTeams: captainedTeams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        memberCount: t._count.members,
        meetsSizeLimits:
          t._count.members >= comp.minTeamSize && t._count.members <= comp.maxTeamSize,
      })),
      canCancel,
      cancelReason,
      history,
    };
  }

  async getMyRegistrationHistory(userId: string) {
    const [registrations, events] = await Promise.all([
      this.prisma.competitionRegistration.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        include: {
          competition: {
            select: { id: true, slug: true, title: true, status: true, startsAt: true, endsAt: true },
          },
        },
      }),
      this.prisma.registrationEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          competition: { select: { slug: true, title: true } },
        },
      }),
    ]);

    return { registrations, history: events };
  }

  async listCompetitionRegistrationsAdmin(auth: AuthenticatedContext, competitionId: string) {
    await this.assertManageAccess(auth, competitionId);

    const [registrations, teams] = await Promise.all([
      this.prisma.competitionRegistration.findMany({
        where: { competitionId },
        orderBy: { registeredAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, displayName: true, country: true } },
        },
      }),
      this.prisma.competitionTeam.findMany({
        where: { competitionId },
        orderBy: { registeredAt: 'desc' },
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
    ]);

    return { registrations, teams };
  }

  async manageRegistrationStatus(
    auth: AuthenticatedContext,
    competitionId: string,
    registrationId: string,
    input: { status: 'CONFIRMED' | 'DISQUALIFIED'; reason?: string },
    ipAddress?: string,
  ) {
    await this.assertManageAccess(auth, competitionId);

    const reg = await this.prisma.competitionRegistration.findFirst({
      where: { id: registrationId, competitionId },
    });
    if (!reg) throw new NotFoundError('Registration record not found');
    if (reg.status === 'WITHDRAWN') {
      throw new BadRequestError('Cannot reinstate a withdrawn registration via admin override');
    }

    const action = input.status === 'DISQUALIFIED' ? 'DISQUALIFIED' : 'REINSTATED';

    await this.prisma.$transaction(async (tx) => {
      if (reg.teamId) {
        await tx.competitionTeam.updateMany({
          where: { competitionId, teamId: reg.teamId },
          data: { status: input.status },
        });
        const members = await tx.competitionRegistration.findMany({
          where: { competitionId, teamId: reg.teamId },
        });
        await tx.competitionRegistration.updateMany({
          where: { competitionId, teamId: reg.teamId },
          data: { status: input.status },
        });
        for (const m of members) {
          await tx.registrationEvent.create({
            data: {
              competitionId,
              userId: m.userId,
              teamId: reg.teamId,
              action,
              actorId: auth.userId,
              reason: input.reason ?? null,
            },
          });
        }
      } else {
        await tx.competitionRegistration.update({
          where: { id: reg.id },
          data: { status: input.status },
        });
        await tx.registrationEvent.create({
          data: {
            competitionId,
            userId: reg.userId,
            action,
            actorId: auth.userId,
            reason: input.reason ?? null,
          },
        });
      }
    });

    await this.audit.record({
      actorId: auth.userId,
      action: `COMPETITION_REGISTRATION_${action}`,
      entityType: 'CompetitionRegistration',
      entityId: reg.id,
      metadata: { competitionId, teamId: reg.teamId, reason: input.reason ?? null },
      ipAddress,
    });

    return { updated: true, status: input.status };
  }
}
