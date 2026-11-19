import type { PrismaClient } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import type { RoleName } from '@dusklabs/shared';
import type { AuditService } from '../audit/audit.service.js';
import type { PlatformSettingsService } from '../settings/settings.service.js';
import {
  dummyVerifyPassword,
  generateOpaqueToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../../utils/crypto.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
} from '../../utils/errors.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export interface DevTokenOutbox {
  emailVerifyTokens: Map<string, string>;
  passwordResetTokens: Map<string, string>;
}

export class AuthService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly isNonProduction: boolean,
    readonly devOutbox: DevTokenOutbox = {
      emailVerifyTokens: new Map(),
      passwordResetTokens: new Map(),
    },
    private readonly settingsService?: PlatformSettingsService,
  ) {}

  async register(
    input: {
      username: string;
      displayName: string;
      email: string;
      password: string;
      country?: string;
      registrationCode?: string;
    },
    ipAddress?: string,
  ) {
    const cfg = await this.settingsService?.getSettings();
    if (cfg && !cfg.registrationEnabled) {
      throw new ForbiddenError('New user registrations are currently disabled', 'REGISTRATION_DISABLED');
    }

    if (cfg?.registrationCode) {
      const expected = Buffer.from(cfg.registrationCode, 'utf8');
      const provided = Buffer.from(sha256Hex(input.registrationCode ?? ''), 'utf8');
      const matches = expected.length === provided.length && timingSafeEqual(expected, provided);
      if (!matches) {
        throw new ForbiddenError('A valid registration code is required', 'REGISTRATION_CODE_REQUIRED');
      }
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: input.username }, { email: input.email }],
      },
      select: { username: true, email: true },
    });

    if (existing) {
      throw new ConflictError(
        existing.email === input.email
          ? 'Email address is already registered'
          : 'Username is already taken',
      );
    }

    const participantRole = await this.prisma.role.findUnique({
      where: { name: 'PARTICIPANT' satisfies RoleName },
    });
    if (!participantRole) {
      throw new Error('System role PARTICIPANT is missing; run database seed');
    }

    const passwordHash = await hashPassword(input.password);
    const verifyToken = generateOpaqueToken(32);
    const verifyTokenHash = sha256Hex(verifyToken);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          passwordHash,
          country: input.country ?? null,
          emailVerifyTokenHash: verifyTokenHash,
          emailVerifyExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          country: true,
          accountStatus: true,
          createdAt: true,
        },
      });

      await tx.userRole.create({
        data: {
          userId: created.id,
          roleId: participantRole.id,
        },
      });

      return created;
    });

    if (this.isNonProduction) {
      this.devOutbox.emailVerifyTokens.set(user.email, verifyToken);
    }

    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_REGISTER',
      entityType: 'User',
      entityId: user.id,
      metadata: { username: user.username },
      ipAddress,
    });

    return { user };
  }

  async verifyEmail(token: string, ipAddress?: string) {
    const tokenHash = sha256Hex(token);
    const user = await this.prisma.user.findFirst({
      where: {
        emailVerifyTokenHash: tokenHash,
        emailVerifyExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestError('Verification token is invalid or expired', 'INVALID_TOKEN');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: new Date(),
        emailVerifyTokenHash: null,
        emailVerifyExpiresAt: null,
      },
    });

    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_EMAIL_VERIFIED',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });

    return { verified: true };
  }

  async login(
    input: { identifier: string; password: string },
    meta: { ipAddress?: string; userAgent?: string },
  ) {
    const normalized = input.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: normalized }, { email: normalized.toLowerCase() }],
      },
    });

    if (!user || user.deletedAt) {
      await dummyVerifyPassword(input.password);
      throw new UnauthorizedError('Invalid credentials');
    }

    if (user.accountStatus === 'BANNED') {
      throw new ForbiddenError('Account is banned', 'ACCOUNT_RESTRICTED');
    }

    if (user.accountStatus === 'SUSPENDED') {
      if (user.suspendedUntil && user.suspendedUntil.getTime() <= Date.now()) {
        // Temporary suspension has expired — restore atomically before continuing login
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: user.id },
            data: {
              accountStatus: 'ACTIVE',
              suspendedUntil: null,
              version: { increment: 1 },
            },
          }),
          this.prisma.accountModerationRecord.create({
            data: {
              userId: user.id,
              action: 'RESTORED',
              previousStatus: 'SUSPENDED',
              newStatus: 'ACTIVE',
              reason: 'Temporary suspension expired',
              actorId: null,
            },
          }),
        ]);
        await this.audit.record({
          actorId: null,
          action: 'USER_SUSPENSION_EXPIRED',
          entityType: 'User',
          entityId: user.id,
          metadata: { previousStatus: 'SUSPENDED', newStatus: 'ACTIVE' },
          ipAddress: meta.ipAddress,
        });
      } else {
        throw new ForbiddenError('Account is suspended', 'ACCOUNT_RESTRICTED');
      }
    }


    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenError(
        'Account temporarily locked due to repeated failed login attempts',
        'ACCOUNT_LOCKED',
      );
    }

    const passwordValid = await verifyPassword(user.passwordHash, input.password);
    if (!passwordValid) {
      const nextFailures = user.failedLoginAttempts + 1;
      const shouldLock = nextFailures >= MAX_FAILED_LOGINS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : nextFailures,
          lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
        },
      });

      await this.audit.record({
        actorId: user.id,
        action: shouldLock ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        metadata: { attempts: nextFailures },
        ipAddress: meta.ipAddress,
      });

      throw new UnauthorizedError('Invalid credentials');
    }

    const cfgLogin = await this.settingsService?.getSettings();
    if (cfgLogin?.requireEmailVerificationForLogin && !user.emailVerifiedAt) {
      throw new ForbiddenError(
        'Email verification is required before signing in',
        'EMAIL_VERIFICATION_REQUIRED',
      );
    }

    const rawSessionToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawSessionToken);
    const csrfSecret = generateOpaqueToken(24);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      }),
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash,
          csrfSecret,
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
          expiresAt,
        },
      }),
    ]);

    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_LOGIN_SUCCESS',
      entityType: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress,
    });

    return {
      rawSessionToken,
      csrfSecret,
      expiresAt,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
      },
    };
  }

  async logout(sessionId: string, userId: string, ipAddress?: string) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actorId: userId,
      action: 'AUTH_LOGOUT',
      entityType: 'Session',
      entityId: sessionId,
      ipAddress,
    });
  }

  async forgotPassword(email: string, ipAddress?: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.accountStatus !== 'ACTIVE' || user.deletedAt) {
      // Anti-enumeration: identical response regardless of whether account exists
      return { requested: true };
    }

    const rawToken = generateOpaqueToken(32);
    const tokenHash = sha256Hex(rawToken);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    if (this.isNonProduction) {
      this.devOutbox.passwordResetTokens.set(user.email, rawToken);
    }

    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });

    return { requested: true };
  }

  async resetPassword(token: string, newPassword: string, ipAddress?: string) {
    const tokenHash = sha256Hex(token);
    const user = await this.prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestError('Password reset token is invalid or expired', 'INVALID_TOKEN');
    }

    const newHash = await hashPassword(newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: newHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      // Revoke every existing session on credential reset
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit.record({
      actorId: user.id,
      action: 'AUTH_PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });

    return { reset: true };
  }
}
