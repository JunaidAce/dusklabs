import type { FastifyInstance } from 'fastify';
import type { AdminOverviewService } from './adminOverview.service.js';

export function registerAdminOverviewRoutes(
  app: FastifyInstance,
  deps: {
    adminOverviewService: AdminOverviewService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/admin/overview',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('audit:logs:read', 'user:manage'),
      ],
    },
    async () => deps.adminOverviewService.getDashboardOverview(),
  );
}
