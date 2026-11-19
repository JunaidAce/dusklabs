import {
  AccountStatuses,
  assignRoleSchema,
  banUserSchema,
  restoreUserSchema,
  RoleNames,
  suspendUserSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminUsersService } from './adminUsers.service.js';

export function registerAdminUserRoutes(
  app: FastifyInstance,
  deps: {
    adminUsersService: AdminUsersService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/admin/users',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('user:manage'),
      ],
    },
    async (request) => {
      const q = z
        .object({
          search: z.string().max(120).optional(),
          status: z.enum(AccountStatuses).optional(),
          role: z.enum(RoleNames).optional(),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.adminUsersService.listUsers(q);
    },
  );

  app.get(
    '/api/v1/admin/users/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('user:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.adminUsersService.getUserDetail(id);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/roles',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('admin:roles:assign'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { roleName } = assignRoleSchema.parse(request.body);
      return deps.adminUsersService.assignRole(request.auth!, id, roleName, request.ip);
    },
  );

  app.delete(
    '/api/v1/admin/users/:id/roles/:roleName',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('admin:roles:assign'),
      ],
    },
    async (request) => {
      const { id, roleName } = z
        .object({ id: z.string().cuid(), roleName: z.enum(RoleNames) })
        .parse(request.params);
      return deps.adminUsersService.revokeRole(request.auth!, id, roleName, request.ip);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/suspend',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('user:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = suspendUserSchema.parse(request.body);
      return deps.adminUsersService.suspendUser(request.auth!, id, body, request.ip);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/ban',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('user:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = banUserSchema.parse(request.body);
      return deps.adminUsersService.banUser(request.auth!, id, body, request.ip);
    },
  );

  app.post(
    '/api/v1/admin/users/:id/restore',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('user:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = restoreUserSchema.parse(request.body);
      return deps.adminUsersService.restoreUser(request.auth!, id, body, request.ip);
    },
  );
}
