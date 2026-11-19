import {
  createReportSchema,
  moderateReportSchema,
  ReportCategories,
  ReportStatuses,
  resolveDisputeSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ModerationService } from './moderation.service.js';

export function registerModerationRoutes(
  app: FastifyInstance,
  deps: {
    moderationService: ModerationService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  const adminRateConfig = {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  };

  // Participant Report Filing
  app.post(
    '/api/v1/reports',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('report:submit'),
      ],
    },
    async (request, reply) => {
      const body = createReportSchema.parse(request.body);
      const res = await deps.moderationService.submitReport(
        request.auth!.userId,
        body,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.get(
    '/api/v1/reports/my',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => deps.moderationService.listMyReports(request.auth!.userId),
  );

  // Submission Inspector
  app.get(
    '/api/v1/admin/submissions',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('submission:inspect'),
      ],
    },
    async (request) => {
      const q = z
        .object({
          search: z.string().max(120).optional(),
          isCorrect: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === 'true')),
          challengeId: z.string().cuid().optional(),
          competitionId: z.string().cuid().optional(),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.moderationService.listSubmissions(request.auth!, q);
    },
  );

  app.get(
    '/api/v1/admin/submissions/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('submission:inspect'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.moderationService.getSubmissionDetail(request.auth!, id);
    },
  );

  app.post(
    '/api/v1/admin/submissions/:id/dispute',
    {
      ...adminRateConfig,
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('submission:inspect', 'score:adjust'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = resolveDisputeSchema.parse(request.body);
      return deps.moderationService.resolveSubmissionDispute(
        request.auth!,
        id,
        body,
        request.ip,
      );
    },
  );

  // Suspicious Activity
  app.get(
    '/api/v1/admin/moderation/suspicious',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('submission:inspect'),
      ],
    },
    async (request) => deps.moderationService.getSuspiciousActivitySummary(request.auth!),
  );

  // Abuse & Bug Report Queue
  app.get(
    '/api/v1/admin/reports',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('report:moderate'),
      ],
    },
    async (request) => {
      const q = z
        .object({
          status: z.enum(ReportStatuses).optional(),
          category: z.enum(ReportCategories).optional(),
          assignedToMe: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.moderationService.listReportsAdmin(request.auth!, q);
    },
  );

  app.patch(
    '/api/v1/admin/reports/:id',
    {
      ...adminRateConfig,
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('report:moderate'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = moderateReportSchema.parse(request.body);
      return deps.moderationService.moderateReport(request.auth!, id, body, request.ip);
    },
  );
}
