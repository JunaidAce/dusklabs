import { createAnnouncementSchema, updateAnnouncementSchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AnnouncementsService } from './announcements.service.js';

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  deps: {
    announcementsService: AnnouncementsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get('/api/v1/announcements', async () =>
    deps.announcementsService.listGlobalAnnouncements(),
  );

  app.post(
    '/api/v1/admin/announcements',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('announcement:publish'),
      ],
    },
    async (request, reply) => {
      const body = createAnnouncementSchema.parse(request.body);
      const res = await deps.announcementsService.createGlobalAnnouncement(
        request.auth!,
        body,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.post(
    '/api/v1/competitions/:id/announcements',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('announcement:publish'),
      ],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = createAnnouncementSchema.parse(request.body);
      const res = await deps.announcementsService.createCompetitionAnnouncement(
        request.auth!,
        id,
        body,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/announcements/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('announcement:publish'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateAnnouncementSchema.parse(request.body);
      return deps.announcementsService.updateAnnouncement(request.auth!, id, body, request.ip);
    },
  );

  app.delete(
    '/api/v1/announcements/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('announcement:publish'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.announcementsService.deleteAnnouncement(request.auth!, id, request.ip);
    },
  );
}
