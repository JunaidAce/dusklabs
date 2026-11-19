import {
  assignOrganizerSchema,
  CompetitionStatuses,
  createCompetitionSchema,
  transitionCompetitionSchema,
  updateCompetitionSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CompetitionsService } from './competitions.service.js';

export function registerCompetitionRoutes(
  app: FastifyInstance,
  deps: {
    competitionsService: CompetitionsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get('/api/v1/competitions', async (request) => {
    const query = z
      .object({
        search: z.string().max(80).optional(),
        status: z.enum(CompetitionStatuses).optional(),
        phase: z.enum(['ALL', 'LIVE', 'REGISTRATION_OPEN', 'UPCOMING', 'COMPLETED']).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(request.query);
    return deps.competitionsService.listPublicCompetitions(query);
  });

  app.get(
    '/api/v1/competitions/:slug',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
      return deps.competitionsService.getPublicCompetitionBySlug(slug, request.auth);
    },
  );

  app.get(
    '/api/v1/competitions/:slug/announcements',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
      return deps.competitionsService.listPublicAnnouncements(slug, request.auth);
    },
  );

  app.get(
    '/api/v1/admin/competitions',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('competition:create'),
      ],
    },
    async (request) => deps.competitionsService.listAdminCompetitions(request.auth!),
  );

  app.get(
    '/api/v1/admin/competitions/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.competitionsService.getAdminCompetitionById(request.auth!, id);
    },
  );

  app.post(
    '/api/v1/competitions',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:create'),
      ],
    },
    async (request, reply) => {
      const body = createCompetitionSchema.parse(request.body);
      const res = await deps.competitionsService.createCompetition(request.auth!, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/competitions/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateCompetitionSchema.parse(request.body);
      return deps.competitionsService.updateCompetition(request.auth!, id, body, request.ip);
    },
  );

  app.post(
    '/api/v1/competitions/:id/publish',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.competitionsService.publishCompetition(request.auth!, id, request.ip);
    },
  );

  app.post(
    '/api/v1/competitions/:id/archive',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.competitionsService.archiveCompetition(request.auth!, id, request.ip);
    },
  );

  app.post(
      '/api/v1/competitions/:id/transition',
      {
        preHandler: [
          deps.attachSession,
          deps.requireAuth,
          deps.requireCsrf,
          deps.requirePermission('competition:transition'),
        ],
      },
      async (request) => {
        const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
        const { targetStatus, reason } = transitionCompetitionSchema.parse(request.body);
        return deps.competitionsService.transitionCompetition(
          request.auth!,
          id,
          targetStatus,
          reason,
          request.ip,
        );
      },
    );

  app.delete(
    '/api/v1/competitions/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.competitionsService.deleteCompetition(request.auth!, id, request.ip);
    },
  );

  app.post(
    '/api/v1/competitions/:id/organizers',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { userId } = assignOrganizerSchema.parse(request.body);
      return deps.competitionsService.assignOrganizer(request.auth!, id, userId, request.ip);
    },
  );

  app.delete(
    '/api/v1/competitions/:id/organizers/:userId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id, userId } = z
        .object({ id: z.string().cuid(), userId: z.string().cuid() })
        .parse(request.params);
      return deps.competitionsService.removeOrganizer(request.auth!, id, userId, request.ip);
    },
  );
}
