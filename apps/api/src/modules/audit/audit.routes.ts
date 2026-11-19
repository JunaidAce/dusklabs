import { auditQuerySchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditService } from './audit.service.js';

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: {
    auditService: AuditService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/admin/audit-logs',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('audit:logs:read'),
      ],
    },
    async (request) => {
      const query = auditQuerySchema.parse(request.query);
      return deps.auditService.queryLogs(request.auth!, query);
    },
  );

  app.get(
    '/api/v1/admin/audit-logs/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('audit:logs:read'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.auditService.getLogById(request.auth!, id);
    },
  );

  // Explicit immutability guard — audit records cannot be modified or deleted
  for (const method of ['put', 'patch', 'delete'] as const) {
    app[method](
      '/api/v1/admin/audit-logs/:id',
      { preHandler: [deps.attachSession, deps.requireAuth] },
      async (_request, reply) =>
        reply.status(405).send({
          error: {
            code: 'AUDIT_IMMUTABLE',
            message: 'Audit records are immutable and cannot be modified or deleted.',
          },
        }),
    );
  }
}
