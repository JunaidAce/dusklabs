import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnalyticsService } from './analytics.service.js';

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: {
    analyticsService: AnalyticsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/admin/analytics/platform',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('analytics:export'),
      ],
    },
    async (request) => deps.analyticsService.getPlatformAnalytics(request.auth!),
  );

  app.get(
    '/api/v1/admin/analytics/competitions/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('analytics:export'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.analyticsService.getCompetitionAnalytics(request.auth!, id);
    },
  );

  const exportHandler =
    (kind: 'standings' | 'challenges' | 'submissions') =>
    async (request: any, reply: any) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const meta = { correlationId: request.id, ipAddress: request.ip };

      const result =
        kind === 'standings'
          ? await deps.analyticsService.exportStandingsCsv(request.auth!, id, meta)
          : kind === 'challenges'
            ? await deps.analyticsService.exportChallengeStatsCsv(request.auth!, id, meta)
            : await deps.analyticsService.exportSubmissionsSummaryCsv(request.auth!, id, meta);

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      return reply.send(result.csv);
    };

  app.get(
    '/api/v1/admin/analytics/competitions/:id/export/standings.csv',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('analytics:export'),
      ],
    },
    exportHandler('standings'),
  );

  app.get(
    '/api/v1/admin/analytics/competitions/:id/export/challenges.csv',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('analytics:export'),
      ],
    },
    exportHandler('challenges'),
  );

  app.get(
    '/api/v1/admin/analytics/competitions/:id/export/submissions.csv',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('analytics:export'),
      ],
    },
    exportHandler('submissions'),
  );
}
