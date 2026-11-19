import type { PermissionKey, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { constantTimeEqual, sha256Hex } from '../utils/crypto.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';

export const SESSION_COOKIE_NAME = 'dusklabs_sid';
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface AuthenticatedContext {
  sessionId: string;
  csrfSecret: string;
  userId: string;
  username: string;
  email: string;
  displayName: string;
  roles: RoleName[];
  permissions: Set<PermissionKey>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedContext | null;
  }
}

export function createAuthMiddleware(prisma: PrismaClient, allowedOrigins: string[]) {
  async function attachSession(request: FastifyRequest): Promise<void> {
    request.auth = null;
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken || typeof rawToken !== 'string') {
      return;
    }

    const tokenHash = sha256Hex(rawToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            roles: {
              include: {
                role: {
                  include: {
                    permissions: {
                      include: { permission: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!session || session.revokedAt) {
      return;
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      return;
    }
    if (now - session.lastActiveAt.getTime() > SESSION_IDLE_MS) {
      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      return;
    }

    if (session.user.accountStatus !== 'ACTIVE' || session.user.deletedAt) {
      return;
    }

    // Throttle lastActiveAt writes to once per 60 seconds
    if (now - session.lastActiveAt.getTime() > 60_000) {
      await prisma.session.update({
        where: { id: session.id },
        data: { lastActiveAt: new Date() },
      });
    }

    const roles: RoleName[] = [];
    const permissions = new Set<PermissionKey>();
    for (const ur of session.user.roles) {
      roles.push(ur.role.name as RoleName);
      for (const rp of ur.role.permissions) {
        permissions.add(rp.permission.key as PermissionKey);
      }
    }

    request.auth = {
      sessionId: session.id,
      csrfSecret: session.csrfSecret,
      userId: session.user.id,
      username: session.user.username,
      email: session.user.email,
      displayName: session.user.displayName,
      roles,
      permissions,
    };
  }

  async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      throw new UnauthorizedError('Valid authenticated session required');
    }
  }

  async function requireCsrf(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      throw new UnauthorizedError('Authentication required');
    }

    const originHeader = request.headers.origin;
    if (originHeader) {
      if (!allowedOrigins.includes(originHeader)) {
        throw new ForbiddenError('Origin validation failed', 'CSRF_ORIGIN_MISMATCH');
      }
    } else if (typeof request.headers.referer === 'string') {
      try {
        const refOrigin = new URL(request.headers.referer).origin;
        if (!allowedOrigins.includes(refOrigin)) {
          throw new ForbiddenError('Referer origin validation failed', 'CSRF_ORIGIN_MISMATCH');
        }
      } catch (err) {
        if (err instanceof ForbiddenError) throw err;
        throw new ForbiddenError('Invalid referer header', 'CSRF_ORIGIN_MISMATCH');
      }
    }

    const csrfHeader = request.headers['x-csrf-token'];
    if (typeof csrfHeader !== 'string' || !constantTimeEqual(csrfHeader, request.auth.csrfSecret)) {
      throw new ForbiddenError('Invalid or missing CSRF token', 'CSRF_INVALID');
    }
  }

  function requirePermission(...required: PermissionKey[]) {
    return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
      if (!request.auth) {
        throw new UnauthorizedError('Authentication required');
      }
      const hasAll = required.every((perm) => request.auth!.permissions.has(perm));
      if (!hasAll) {
        throw new ForbiddenError('You do not have permission to perform this action');
      }
    };
  }

  return { attachSession, requireAuth, requireCsrf, requirePermission };
}
