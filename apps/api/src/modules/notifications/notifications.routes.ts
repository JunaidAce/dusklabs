import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationsService } from './notifications.service.js';

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: {
    notificationsService: NotificationsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/notifications',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => {
      const q = z
        .object({
          unreadOnly: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.notificationsService.listUserNotifications(request.auth!.userId, q);
    },
  );

  app.patch(
    '/api/v1/notifications/:id/read',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.notificationsService.markAsRead(request.auth!.userId, id);
    },
  );

  app.post(
    '/api/v1/notifications/read-all',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => deps.notificationsService.markAllAsRead(request.auth!.userId),
  );
}
