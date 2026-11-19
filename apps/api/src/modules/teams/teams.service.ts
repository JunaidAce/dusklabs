import type { PrismaClient } from '@prisma/client';
import type { RoleName } from '@dusklabs/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { PlatformSettingsService } from '../settings/settings.service.js';
import { generateOpaqueToken, sha256Hex } from '../../utils/crypto.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';

const MAX_PLATFORM_TEAM_SIZE = 20;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function toSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length >= 2 ? base : `team-${generateOpaqueToken(4).toLowerCase()}`;
}

export class TeamsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly settingsService?: PlatformSettingsService,
  ) {}

  private async assertRosterChangeAllowed(
    tx: Pick<PrismaClient, 'competitionTeam' | 'teamMember' | 'competitionRegistration'>,
    teamId: string,
    addingUserId?: string,
  ): Promise<void> {
    const teamComps = await tx.competitionTeam.findMany({
      where: { teamId, status: 'CONFIRMED' },
      include: { competition: true },
    });

    const currentMemberCount = await tx.teamMember.count({ where: { teamId } });

    const platformMaxTeamSize =
      (await this.settingsService?.getSettings())?.defaultMaxTeamSize ?? MAX_PLATFORM_TEAM_SIZE;
    if (addingUserId && currentMemberCount >= platformMaxTeamSize) {
      throw new ConflictError(`Team has reached maximum platform size (${platformMaxTeamSize})`, 'TEAM_FULL');
    }

    for (const tc of teamComps) {
      const comp = tc.competition;
      if (comp.status === 'LIVE' && comp.lockTeamRosterOnLive) {
        throw new ConflictError(
          `Team roster is locked while competition "${comp.title}" is LIVE`,
          'ROSTER_LOCKED',
        );
      }

      if (addingUserId) {
        if (currentMemberCount + 1 > comp.maxTeamSize) {
          throw new ConflictError(
            `Cannot exceed team size limit (${comp.maxTeamSize}) for competition "${comp.title}"`,
            'TEAM_SIZE_LIMIT_REACHED',
          );
        }

        // Prevent same user competing on two teams or individually in the same competition
        const conflictingReg = await tx.competitionRegistration.findUnique({
          where: {
            competitionId_userId: { competitionId: comp.id, userId: addingUserId },
          },
        });
        if (conflictingReg && conflictingReg.teamId !== teamId) {
          throw new ConflictError(
            `User is already registered in competition "${comp.title}"`,
            'COMPETITION_CONFLICT',
          );
        }
      }
    }
  }

  private async ensureCaptainRole(
    tx: Pick<PrismaClient, 'role' | 'userRole'>,
    userId: string,
  ): Promise<void> {
    const captainRole = await tx.role.findUnique({
      where: { name: 'TEAM_CAPTAIN' satisfies RoleName },
    });
    if (!captainRole) return;
    await tx.userRole.upsert({
      where: { userId_roleId: { userId, roleId: captainRole.id } },
      update: {},
      create: { userId, roleId: captainRole.id },
    });
  }

  private async syncOldCaptainRole(
    tx: Pick<PrismaClient, 'role' | 'team' | 'userRole'>,
    userId: string,
  ): Promise<void> {
    const remainingOwned = await tx.team.count({
      where: { captainId: userId, deletedAt: null },
    });
    if (remainingOwned > 0) return;
    const captainRole = await tx.role.findUnique({
      where: { name: 'TEAM_CAPTAIN' satisfies RoleName },
    });
    if (!captainRole) return;
    await tx.userRole.deleteMany({
      where: { userId, roleId: captainRole.id },
    });
  }

  async listTeams(query: { search?: string; page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const search = query.search?.trim();

    const where = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { slug: { contains: search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [teams, total] = await Promise.all([
      this.prisma.team.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          bio: true,
          logoUrl: true,
          createdAt: true,
          captain: { select: { id: true, username: true, displayName: true } },
          _count: { select: { members: true, solves: true } },
        },
      }),
      this.prisma.team.count({ where }),
    ]);

    return {
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        bio: t.bio,
        logoUrl: t.logoUrl,
        createdAt: t.createdAt,
        captain: t.captain,
        memberCount: t._count.members,
        solveCount: t._count.solves,
      })),
      pagination: { page, limit, total },
    };
  }

  async getMyTeams(userId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId, team: { deletedAt: null } },
      include: {
        team: {
          include: {
            _count: { select: { members: true, solves: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const receivedInvitations = await this.prisma.teamInvitation.findMany({
      where: {
        invitedUserId: userId,
        type: 'INVITE',
        status: 'PENDING',
        expiresAt: { gt: new Date() },
        team: { deletedAt: null },
      },
      include: {
        team: { select: { id: true, name: true, slug: true } },
        invitedBy: { select: { username: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      teams: memberships.map((m) => ({
        id: m.team.id,
        name: m.team.name,
        slug: m.team.slug,
        role: m.role,
        inviteCode: m.team.captainId === userId ? m.team.inviteCode : undefined,
        memberCount: m.team._count.members,
        solveCount: m.team._count.solves,
      })),
      receivedInvitations: receivedInvitations.map((inv) => ({
        id: inv.id,
        team: inv.team,
        invitedBy: inv.invitedBy,
        message: inv.message,
        expiresAt: inv.expiresAt,
      })),
    };
  }

  async getTeamBySlug(slug: string, viewerUserId?: string) {
    const team = await this.prisma.team.findFirst({
      where: { slug, deletedAt: null },
      include: {
        members: {
          orderBy: { joinedAt: 'asc' },
          include: {
            user: {
              select: { id: true, username: true, displayName: true, country: true },
            },
          },
        },
        competitions: {
          include: {
            competition: {
              select: { id: true, slug: true, title: true, status: true, startsAt: true, endsAt: true },
            },
          },
        },
      },
    });

    if (!team) {
      throw new NotFoundError('Team not found');
    }

    const scoreAgg = await this.prisma.scoreTransaction.aggregate({
      where: { teamId: team.id },
      _sum: { deltaPoints: true },
    });

    const solveCount = await this.prisma.solve.count({ where: { teamId: team.id } });
    const isCaptain = Boolean(viewerUserId && team.captainId === viewerUserId);
    const isMember = Boolean(viewerUserId && team.members.some((m) => m.userId === viewerUserId));

    let pendingInvitations: Array<{
      id: string;
      type: string;
      status: string;
      message: string | null;
      email: string | null;
      createdAt: Date;
      invitedUser: { id: string; username: string; displayName: string } | null;
      invitedBy: { id: string; username: string; displayName: string };
    }> = [];

    if (isCaptain) {
      pendingInvitations = await this.prisma.teamInvitation.findMany({
        where: { teamId: team.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          status: true,
          message: true,
          email: true,
          createdAt: true,
          invitedUser: { select: { id: true, username: true, displayName: true } },
          invitedBy: { select: { id: true, username: true, displayName: true } },
        },
      });
    }

    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      bio: team.bio,
      logoUrl: team.logoUrl,
      captainId: team.captainId,
      createdAt: team.createdAt,
      totalPoints: scoreAgg._sum.deltaPoints ?? 0,
      solveCount,
      isMember,
      isCaptain,
      inviteCode: isCaptain ? team.inviteCode : undefined,
      members: team.members.map((m) => ({
        userId: m.user.id,
        username: m.user.username,
        displayName: m.user.displayName,
        country: m.user.country,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      competitions: team.competitions.map((c) => c.competition),
      pendingInvitations: isCaptain ? pendingInvitations : undefined,
    };
  }

  async createTeam(
    userId: string,
    input: { name: string; bio?: string; logoUrl?: string },
    ipAddress?: string,
  ) {
    const cfgTeam = await this.settingsService?.getSettings();
    if (cfgTeam && !cfgTeam.teamCreationEnabled) {
      throw new ForbiddenError('Team creation is currently disabled', 'TEAM_CREATION_DISABLED');
    }

    const existingName = await this.prisma.team.findUnique({ where: { name: input.name } });
    if (existingName) {
      throw new ConflictError('A team with this name already exists');
    }

    let slug = toSlug(input.name);
    const existingSlug = await this.prisma.team.findUnique({ where: { slug } });
    if (existingSlug) {
      slug = `${slug}-${generateOpaqueToken(3).toLowerCase()}`;
    }

    const inviteCode = generateOpaqueToken(9);

    const team = await this.prisma.$transaction(async (tx) => {
      const created = await tx.team.create({
        data: {
          name: input.name,
          slug,
          bio: input.bio ?? null,
          logoUrl: input.logoUrl ?? null,
          captainId: userId,
          inviteCode,
        },
      });

      await tx.teamMember.create({
        data: {
          teamId: created.id,
          userId,
          role: 'CAPTAIN',
        },
      });

      await this.ensureCaptainRole(tx, userId);
      return created;
    });

    await this.audit.record({
      actorId: userId,
      action: 'TEAM_CREATED',
      entityType: 'Team',
      entityId: team.id,
      metadata: { name: team.name, slug: team.slug },
      ipAddress,
    });

    return { team };
  }

  async updateTeam(
    teamId: string,
    actorId: string,
    input: { name?: string; bio?: string | null; logoUrl?: string | null },
    ipAddress?: string,
  ) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');
    if (team.captainId !== actorId) {
      throw new ForbiddenError('Only the team captain can update team details');
    }

    if (input.name && input.name !== team.name) {
      const conflict = await this.prisma.team.findUnique({ where: { name: input.name } });
      if (conflict) throw new ConflictError('Team name is already in use');
    }

    const updated = await this.prisma.team.update({
      where: { id: teamId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      },
      select: { id: true, name: true, slug: true, bio: true, logoUrl: true },
    });

    await this.audit.record({
      actorId,
      action: 'TEAM_UPDATED',
      entityType: 'Team',
      entityId: teamId,
      ipAddress,
    });

    return { team: updated };
  }

  async regenerateInviteCode(teamId: string, actorId: string, ipAddress?: string) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');
    if (team.captainId !== actorId) {
      throw new ForbiddenError('Only the team captain can regenerate the invite code');
    }

    const inviteCode = generateOpaqueToken(9);
    await this.prisma.team.update({ where: { id: teamId }, data: { inviteCode } });

    await this.audit.record({
      actorId,
      action: 'TEAM_INVITE_CODE_REGENERATED',
      entityType: 'Team',
      entityId: teamId,
      ipAddress,
    });

    return { inviteCode };
  }

  async inviteMember(
    teamId: string,
    captainId: string,
    input: { username?: string; email?: string; message?: string },
    ipAddress?: string,
  ) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');
    if (team.captainId !== captainId) {
      throw new ForbiddenError('Only the team captain can send invitations');
    }

    const targetUser = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        accountStatus: 'ACTIVE',
        ...(input.username ? { username: input.username } : { email: input.email }),
      },
      select: { id: true, username: true, email: true },
    });

    if (!targetUser) {
      throw new NotFoundError('Target participant account not found');
    }

    const alreadyMember = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: targetUser.id } },
    });
    if (alreadyMember) {
      throw new ConflictError('User is already a member of this team');
    }

    await this.assertRosterChangeAllowed(this.prisma, teamId, targetUser.id);

    const existingPending = await this.prisma.teamInvitation.findFirst({
      where: {
        teamId,
        type: 'INVITE',
        invitedUserId: targetUser.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
    if (existingPending) {
      throw new ConflictError('An active invitation for this user already exists');
    }

    const invitation = await this.prisma.teamInvitation.create({
      data: {
        teamId,
        type: 'INVITE',
        invitedById: captainId,
        invitedUserId: targetUser.id,
        email: targetUser.email,
        message: input.message ?? null,
        tokenHash: sha256Hex(generateOpaqueToken(24)),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true, teamId: true, type: true, status: true, expiresAt: true },
    });

    await this.audit.record({
      actorId: captainId,
      action: 'TEAM_INVITATION_SENT',
      entityType: 'TeamInvitation',
      entityId: invitation.id,
      metadata: { teamId, invitedUserId: targetUser.id },
      ipAddress,
    });

    return { invitation };
  }

  async requestToJoin(
    teamId: string,
    userId: string,
    message?: string,
    ipAddress?: string,
  ) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');

    const alreadyMember = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (alreadyMember) {
      throw new ConflictError('You are already a member of this team');
    }

    await this.assertRosterChangeAllowed(this.prisma, teamId, userId);

    const existingPending = await this.prisma.teamInvitation.findFirst({
      where: {
        teamId,
        type: 'REQUEST',
        invitedUserId: userId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
    });
    if (existingPending) {
      throw new ConflictError('You already have a pending join request for this team');
    }

    const request = await this.prisma.teamInvitation.create({
      data: {
        teamId,
        type: 'REQUEST',
        invitedById: userId,
        invitedUserId: userId,
        message: message ?? null,
        tokenHash: sha256Hex(generateOpaqueToken(24)),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true, teamId: true, type: true, status: true, createdAt: true },
    });

    await this.audit.record({
      actorId: userId,
      action: 'TEAM_JOIN_REQUESTED',
      entityType: 'TeamInvitation',
      entityId: request.id,
      metadata: { teamId },
      ipAddress,
    });

    return { request };
  }

  async respondToInvitationOrRequest(
    invitationId: string,
    actorId: string,
    action: 'ACCEPT' | 'DECLINE',
    ipAddress?: string,
  ) {
    const inv = await this.prisma.teamInvitation.findUnique({
      where: { id: invitationId },
      include: { team: true },
    });

    if (!inv || inv.team.deletedAt) {
      throw new NotFoundError('Invitation or join request not found');
    }
    if (inv.status !== 'PENDING' || inv.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestError('Invitation or request is no longer pending');
    }

    if (inv.type === 'INVITE') {
      if (inv.invitedUserId !== actorId) {
        throw new ForbiddenError('Only the invited participant can respond to this invitation');
      }
    } else if (inv.type === 'REQUEST') {
      if (inv.team.captainId !== actorId) {
        throw new ForbiddenError('Only the team captain can approve or decline join requests');
      }
    } else {
      throw new BadRequestError('Unsupported invitation type');
    }

    const targetUserId = inv.invitedUserId;
    if (!targetUserId) {
      throw new BadRequestError('Invitation has no target user');
    }

    if (action === 'DECLINE') {
      await this.prisma.teamInvitation.update({
        where: { id: inv.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      return { status: 'DECLINED' };
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRosterChangeAllowed(tx, inv.teamId, targetUserId);

      const exists = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId: inv.teamId, userId: targetUserId } },
      });
      if (!exists) {
        await tx.teamMember.create({
          data: { teamId: inv.teamId, userId: targetUserId, role: 'MEMBER' },
        });
      }

      await tx.teamInvitation.update({
        where: { id: inv.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });
    });

    await this.audit.record({
      actorId,
      action: inv.type === 'INVITE' ? 'TEAM_INVITE_ACCEPTED' : 'TEAM_REQUEST_APPROVED',
      entityType: 'Team',
      entityId: inv.teamId,
      metadata: { targetUserId },
      ipAddress,
    });

    return { status: 'ACCEPTED', teamSlug: inv.team.slug };
  }

  async joinByCode(userId: string, inviteCode: string, ipAddress?: string) {
    const team = await this.prisma.team.findFirst({
      where: { inviteCode: inviteCode.trim(), deletedAt: null },
    });
    if (!team) {
      throw new NotFoundError('Invalid team invite code');
    }

    const alreadyMember = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: team.id, userId } },
    });
    if (alreadyMember) {
      throw new ConflictError('You are already a member of this team');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRosterChangeAllowed(tx, team.id, userId);
      await tx.teamMember.create({
        data: { teamId: team.id, userId, role: 'MEMBER' },
      });
    });

    await this.audit.record({
      actorId: userId,
      action: 'TEAM_JOINED_BY_CODE',
      entityType: 'Team',
      entityId: team.id,
      ipAddress,
    });

    return { team: { id: team.id, name: team.name, slug: team.slug } };
  }

  async removeMember(
    teamId: string,
    captainId: string,
    targetUserId: string,
    ipAddress?: string,
  ) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');
    if (team.captainId !== captainId) {
      throw new ForbiddenError('Only the team captain can remove members');
    }
    if (targetUserId === captainId) {
      throw new BadRequestError('Captain cannot remove themselves; transfer captaincy or leave');
    }

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: targetUserId } },
    });
    if (!membership) {
      throw new NotFoundError('User is not a member of this team');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRosterChangeAllowed(tx, teamId);
      await tx.teamMember.delete({
        where: { teamId_userId: { teamId, userId: targetUserId } },
      });
    });

    await this.audit.record({
      actorId: captainId,
      action: 'TEAM_MEMBER_REMOVED',
      entityType: 'Team',
      entityId: teamId,
      metadata: { targetUserId },
      ipAddress,
    });

    return { removed: true };
  }

  async leaveTeam(teamId: string, userId: string, ipAddress?: string) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) {
      throw new NotFoundError('You are not a member of this team');
    }

    const memberCount = await this.prisma.teamMember.count({ where: { teamId } });
    if (team.captainId === userId && memberCount > 1) {
      throw new BadRequestError('Transfer team captaincy before leaving a team with other members');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.assertRosterChangeAllowed(tx, teamId);
      await tx.teamMember.delete({ where: { teamId_userId: { teamId, userId } } });

      if (team.captainId === userId) {
        await tx.team.update({
          where: { id: teamId },
          data: { deletedAt: new Date() },
        });
        await this.syncOldCaptainRole(tx, userId);
      }
    });

    await this.audit.record({
      actorId: userId,
      action: team.captainId === userId ? 'TEAM_DISBANDED' : 'TEAM_LEFT',
      entityType: 'Team',
      entityId: teamId,
      ipAddress,
    });

    return { left: true };
  }

  async transferCaptaincy(
    teamId: string,
    currentCaptainId: string,
    newCaptainUserId: string,
    ipAddress?: string,
  ) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, deletedAt: null } });
    if (!team) throw new NotFoundError('Team not found');
    if (team.captainId !== currentCaptainId) {
      throw new ForbiddenError('Only the current team captain can transfer captaincy');
    }
    if (newCaptainUserId === currentCaptainId) {
      throw new BadRequestError('Target user is already the team captain');
    }

    const targetMembership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: newCaptainUserId } },
    });
    if (!targetMembership) {
      throw new BadRequestError('New captain must already be a member of the team');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.team.update({
        where: { id: teamId },
        data: { captainId: newCaptainUserId },
      });
      await tx.teamMember.update({
        where: { teamId_userId: { teamId, userId: currentCaptainId } },
        data: { role: 'MEMBER' },
      });
      await tx.teamMember.update({
        where: { teamId_userId: { teamId, userId: newCaptainUserId } },
        data: { role: 'CAPTAIN' },
      });
      await this.ensureCaptainRole(tx, newCaptainUserId);
      await this.syncOldCaptainRole(tx, currentCaptainId);
    });

    await this.audit.record({
      actorId: currentCaptainId,
      action: 'TEAM_CAPTAIN_TRANSFERRED',
      entityType: 'Team',
      entityId: teamId,
      metadata: { newCaptainUserId },
      ipAddress,
    });

    return { transferred: true, newCaptainUserId };
  }
}
