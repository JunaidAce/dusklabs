import type { AccountStatus, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';

const PROTECTED_ADMIN_ROLES = new Set<RoleName>(['SUPER_ADMIN', 'PLATFORM_ADMIN']);

export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  private isSuperAdmin(auth: AuthenticatedContext): boolean {
    return auth.roles.includes('SUPER_ADMIN' satisfies RoleName);
  }

  private assertCanModerateTarget(
    actor: AuthenticatedContext,
    targetUserId: string,
    targetRoles: string[],
  ): void {
    if (actor.userId === targetUserId) {
      throw new BadRequestError('Administrators cannot suspend or ban their own account');
    }

    if (targetRoles.includes('SUPER_ADMIN') && !this.isSuperAdmin(actor)) {
      throw new ForbiddenError(
        'Only a Super Administrator can moderate or modify a Super Administrator account',
        'INSUFFICIENT_ROLE_HIERARCHY',
      );
    }

    if (
      targetRoles.includes('PLATFORM_ADMIN') &&
      !this.isSuperAdmin(actor)
    ) {
      throw new ForbiddenError(
        'Only a Super Administrator can moderate a Platform Administrator account',
        'INSUFFICIENT_ROLE_HIERARCHY',
      );
    }
  }

  private async countActiveSuperAdmins(
    tx: Pick<PrismaClient, 'userRole'>,
    excludeUserId?: string,
  ): Promise<number> {
    return tx.userRole.count({
      where: {
        role: { name: 'SUPER_ADMIN' },
        user: {
          accountStatus: 'ACTIVE',
          deletedAt: null,
          ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
        },
      },
    });
  }

  async listUsers(query: {
    search?: string;
    status?: AccountStatus;
    role?: RoleName;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));
    const search = query.search?.trim();

    const where: any = {
      deletedAt: null,
      ...(query.status ? { accountStatus: query.status } : {}),
      ...(query.role ? { roles: { some: { role: { name: query.role } } } } : {}),
      ...(search
        ? {
            OR: [
              { id: search },
              { username: { contains: search } },
              { email: { contains: search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          country: true,
          accountStatus: true,
          suspendedUntil: true,
          emailVerifiedAt: true,
          lastLoginAt: true,
          createdAt: true,
          roles: { select: { role: { select: { name: true } } } },
          _count: { select: { solves: true, teamMemberships: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        country: u.country,
        accountStatus: u.accountStatus,
        suspendedUntil: u.suspendedUntil,
        emailVerifiedAt: u.emailVerifiedAt,
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
        roles: u.roles.map((r) => r.role.name),
        solveCount: u._count.solves,
        teamCount: u._count.teamMemberships,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        country: true,
        bio: true,
        accountStatus: true,
        suspendedUntil: true,
        emailVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        roles: {
          select: {
            assignedAt: true,
            role: {
              select: {
                name: true,
                description: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
        teamMemberships: {
          where: { team: { deletedAt: null } },
          select: {
            role: true,
            joinedAt: true,
            team: { select: { id: true, name: true, slug: true } },
          },
        },
        competitionRegistrations: {
          orderBy: { registeredAt: 'desc' },
          take: 20,
          select: {
            id: true,
            status: true,
            registeredAt: true,
            competition: { select: { id: true, slug: true, title: true, status: true } },
          },
        },
        moderationHistory: {
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            action: true,
            previousStatus: true,
            newStatus: true,
            reason: true,
            expiresAt: true,
            createdAt: true,
            actor: { select: { id: true, username: true } },
          },
        },
      },
    });

    if (!user) throw new NotFoundError('User not found');

    const [activeSessionCount, scoreAgg, solveCount] = await Promise.all([
      this.prisma.session.count({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
      this.prisma.scoreTransaction.aggregate({
        where: { userId },
        _sum: { deltaPoints: true },
      }),
      this.prisma.solve.count({ where: { userId } }),
    ]);

    const permissions = new Set<string>();
    for (const ur of user.roles) {
      for (const rp of ur.role.permissions) {
        permissions.add(rp.permission.key);
      }
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        country: user.country,
        bio: user.bio,
        accountStatus: user.accountStatus,
        suspendedUntil: user.suspendedUntil,
        emailVerifiedAt: user.emailVerifiedAt,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        roles: user.roles.map((r) => r.role.name),
        effectivePermissions: Array.from(permissions),
        activeSessionCount,
        totalPoints: Math.max(0, scoreAgg._sum.deltaPoints ?? 0),
        solveCount,
        teams: user.teamMemberships.map((m) => ({
          id: m.team.id,
          name: m.team.name,
          slug: m.team.slug,
          memberRole: m.role,
          joinedAt: m.joinedAt,
        })),
        competitions: user.competitionRegistrations.map((cr) => ({
          registrationId: cr.id,
          status: cr.status,
          registeredAt: cr.registeredAt,
          competition: cr.competition,
        })),
        moderationHistory: user.moderationHistory,
      },
    };
  }

  async assignRole(
    actor: AuthenticatedContext,
    targetUserId: string,
    roleName: RoleName,
    ipAddress?: string,
  ) {
    if (PROTECTED_ADMIN_ROLES.has(roleName) && !this.isSuperAdmin(actor)) {
      throw new ForbiddenError(
        `Only a Super Administrator can assign ${roleName}`,
        'PRIVILEGE_ESCALATION_BLOCKED',
      );
    }

    const [targetUser, role] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: targetUserId },
        include: { roles: { include: { role: true } } },
      }),
      this.prisma.role.findUnique({ where: { name: roleName } }),
    ]);

    if (!targetUser || targetUser.deletedAt) throw new NotFoundError('User not found');
    if (!role) throw new NotFoundError('Role not found');

    const currentRoles = targetUser.roles.map((r) => r.role.name);
    if (currentRoles.includes('SUPER_ADMIN') && !this.isSuperAdmin(actor)) {
      throw new ForbiddenError('Cannot modify roles of a Super Administrator');
    }

    if (currentRoles.includes(roleName)) {
      throw new ConflictError(`User already holds role ${roleName}`);
    }

    await this.prisma.$transaction(async (tx) => {
      const cas = await tx.user.updateMany({
        where: { id: targetUserId, version: targetUser.version },
        data: { version: { increment: 1 } },
      });
      if (cas.count !== 1) {
        throw new ConflictError('User record was modified concurrently', 'CONCURRENT_MODIFICATION');
      }

      await tx.userRole.create({
        data: {
          userId: targetUserId,
          roleId: role.id,
          assignedBy: actor.userId,
        },
      });
    });

    await this.audit.record({
      actorId: actor.userId,
      action: 'USER_ROLE_ASSIGNED',
      entityType: 'User',
      entityId: targetUserId,
      metadata: {
        targetUserId,
        previousRoles: currentRoles,
        addedRole: roleName,
      },
      ipAddress,
    });

    return { assigned: true, roleName };
  }

  async revokeRole(
    actor: AuthenticatedContext,
    targetUserId: string,
    roleName: RoleName,
    ipAddress?: string,
  ) {
    if (PROTECTED_ADMIN_ROLES.has(roleName) && !this.isSuperAdmin(actor)) {
      throw new ForbiddenError(
        `Only a Super Administrator can revoke ${roleName}`,
        'INSUFFICIENT_ROLE_HIERARCHY',
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roles: { include: { role: true } } },
    });
    if (!targetUser || targetUser.deletedAt) throw new NotFoundError('User not found');

    const currentRoles = targetUser.roles.map((r) => r.role.name);
    if (currentRoles.includes('SUPER_ADMIN') && !this.isSuperAdmin(actor)) {
      throw new ForbiddenError('Cannot modify roles of a Super Administrator');
    }

    const targetRoleRow = targetUser.roles.find((r) => r.role.name === roleName);
    if (!targetRoleRow) {
      throw new NotFoundError(`User does not hold role ${roleName}`);
    }

    if (roleName === 'PARTICIPANT' && currentRoles.length === 1) {
      throw new BadRequestError('Cannot remove the sole base PARTICIPANT role');
    }

    await this.prisma.$transaction(async (tx) => {
      if (roleName === 'SUPER_ADMIN') {
        const remainingSuperAdmins = await this.countActiveSuperAdmins(tx, targetUserId);
        if (remainingSuperAdmins < 1) {
          throw new ConflictError(
            'Cannot remove SUPER_ADMIN from the last active Super Administrator',
            'LAST_SUPER_ADMIN_PROTECTED',
          );
        }
      }

      const cas = await tx.user.updateMany({
        where: { id: targetUserId, version: targetUser.version },
        data: { version: { increment: 1 } },
      });
      if (cas.count !== 1) {
        throw new ConflictError('User record was modified concurrently', 'CONCURRENT_MODIFICATION');
      }

      await tx.userRole.delete({
        where: { userId_roleId: { userId: targetUserId, roleId: targetRoleRow.roleId } },
      });
    });

    await this.audit.record({
      actorId: actor.userId,
      action: 'USER_ROLE_REVOKED',
      entityType: 'User',
      entityId: targetUserId,
      metadata: {
        targetUserId,
        previousRoles: currentRoles,
        removedRole: roleName,
      },
      ipAddress,
    });

    return { revoked: true, roleName };
  }

  async suspendUser(
    actor: AuthenticatedContext,
    targetUserId: string,
    input: { reason: string; expiresAt?: string | null },
    ipAddress?: string,
  ) {
    const expiresDate = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresDate && expiresDate.getTime() <= Date.now()) {
      throw new BadRequestError('Suspension expiration must be in the future');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roles: { include: { role: true } } },
    });
    if (!target || target.deletedAt) throw new NotFoundError('User not found');

    const targetRoles = target.roles.map((r) => r.role.name);
    this.assertCanModerateTarget(actor, targetUserId, targetRoles);

    if (target.accountStatus !== 'ACTIVE') {
      throw new BadRequestError(
        `Cannot suspend account from status ${target.accountStatus}`,
        'INVALID_STATUS_TRANSITION',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (targetRoles.includes('SUPER_ADMIN')) {
        const remaining = await this.countActiveSuperAdmins(tx, targetUserId);
        if (remaining < 1) {
          throw new ConflictError(
            'Cannot suspend the last active Super Administrator',
            'LAST_SUPER_ADMIN_PROTECTED',
          );
        }
      }

      const cas = await tx.user.updateMany({
        where: { id: targetUserId, accountStatus: 'ACTIVE', version: target.version },
        data: {
          accountStatus: 'SUSPENDED',
          suspendedUntil: expiresDate,
          version: { increment: 1 },
        },
      });
      if (cas.count !== 1) {
        throw new ConflictError('User status modified concurrently', 'CONCURRENT_MODIFICATION');
      }

      await tx.session.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.accountModerationRecord.create({
        data: {
          userId: targetUserId,
          action: 'SUSPENDED',
          previousStatus: target.accountStatus,
          newStatus: 'SUSPENDED',
          reason: input.reason,
          actorId: actor.userId,
          expiresAt: expiresDate,
        },
      });
    });

    await this.audit.record({
      actorId: actor.userId,
      action: 'USER_SUSPENDED',
      entityType: 'User',
      entityId: targetUserId,
      metadata: {
        previousStatus: target.accountStatus,
        newStatus: 'SUSPENDED',
        reason: input.reason,
        expiresAt: expiresDate?.toISOString() ?? null,
      },
      ipAddress,
    });

    return { status: 'SUSPENDED', suspendedUntil: expiresDate };
  }

  async banUser(
    actor: AuthenticatedContext,
    targetUserId: string,
    input: { reason: string },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roles: { include: { role: true } } },
    });
    if (!target || target.deletedAt) throw new NotFoundError('User not found');

    const targetRoles = target.roles.map((r) => r.role.name);
    this.assertCanModerateTarget(actor, targetUserId, targetRoles);

    if (target.accountStatus !== 'ACTIVE' && target.accountStatus !== 'SUSPENDED') {
      throw new BadRequestError(
        `Cannot ban account from status ${target.accountStatus}`,
        'INVALID_STATUS_TRANSITION',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (targetRoles.includes('SUPER_ADMIN')) {
        const remaining = await this.countActiveSuperAdmins(tx, targetUserId);
        if (remaining < 1) {
          throw new ConflictError(
            'Cannot ban the last active Super Administrator',
            'LAST_SUPER_ADMIN_PROTECTED',
          );
        }
      }

      const cas = await tx.user.updateMany({
        where: {
          id: targetUserId,
          accountStatus: target.accountStatus,
          version: target.version,
        },
        data: {
          accountStatus: 'BANNED',
          suspendedUntil: null,
          version: { increment: 1 },
        },
      });
      if (cas.count !== 1) {
        throw new ConflictError('User status modified concurrently', 'CONCURRENT_MODIFICATION');
      }

      await tx.session.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await tx.accountModerationRecord.create({
        data: {
          userId: targetUserId,
          action: 'BANNED',
          previousStatus: target.accountStatus,
          newStatus: 'BANNED',
          reason: input.reason,
          actorId: actor.userId,
        },
      });
    });

    await this.audit.record({
      actorId: actor.userId,
      action: 'USER_BANNED',
      entityType: 'User',
      entityId: targetUserId,
      metadata: {
        previousStatus: target.accountStatus,
        newStatus: 'BANNED',
        reason: input.reason,
      },
      ipAddress,
    });

    return { status: 'BANNED' };
  }

  async restoreUser(
    actor: AuthenticatedContext,
    targetUserId: string,
    input: { reason: string },
    ipAddress?: string,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      include: { roles: { include: { role: true } } },
    });
    if (!target || target.deletedAt) throw new NotFoundError('User not found');

    const targetRoles = target.roles.map((r) => r.role.name);
    this.assertCanModerateTarget(actor, targetUserId, targetRoles);

    if (target.accountStatus !== 'SUSPENDED' && target.accountStatus !== 'BANNED') {
      throw new BadRequestError(
        `Account is already ${target.accountStatus}; only SUSPENDED or BANNED accounts can be restored`,
        'INVALID_STATUS_TRANSITION',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const cas = await tx.user.updateMany({
        where: {
          id: targetUserId,
          accountStatus: target.accountStatus,
          version: target.version,
        },
        data: {
          accountStatus: 'ACTIVE',
          suspendedUntil: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
          version: { increment: 1 },
        },
      });
      if (cas.count !== 1) {
        throw new ConflictError('User status modified concurrently', 'CONCURRENT_MODIFICATION');
      }

      await tx.accountModerationRecord.create({
        data: {
          userId: targetUserId,
          action: 'RESTORED',
          previousStatus: target.accountStatus,
          newStatus: 'ACTIVE',
          reason: input.reason,
          actorId: actor.userId,
        },
      });
    });

    await this.audit.record({
      actorId: actor.userId,
      action: 'USER_RESTORED',
      entityType: 'User',
      entityId: targetUserId,
      metadata: {
        previousStatus: target.accountStatus,
        newStatus: 'ACTIVE',
        reason: input.reason,
      },
      ipAddress,
    });

    return { status: 'ACTIVE' };
  }
}
