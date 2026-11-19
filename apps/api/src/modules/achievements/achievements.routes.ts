import {
  createAchievementSchema,
  updateAchievementSchema,
  updatePrivacySchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AchievementsService } from './achievements.service.js';

export function registerAchievementRoutes(
  app: FastifyInstance,
  deps: {
    achievementsService: AchievementsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get('/api/v1/achievements', async () =>
    deps.achievementsService.listAvailableAchievements(),
  );

  app.get(
    '/api/v1/achievements/me',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => deps.achievementsService.getMyAchievementsAndProgress(request.auth!.userId),
  );

  app.get(
    '/api/v1/users/:username/achievements',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const { username } = z.object({ username: z.string().min(1).max(32) }).parse(request.params);
      return deps.achievementsService.getPublicProfileSummary(username, request.auth);
    },
  );

  app.patch(
    '/api/v1/users/me/privacy',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { showAchievementsOnProfile } = updatePrivacySchema.parse(request.body);
      return deps.achievementsService.updatePrivacy(request.auth!.userId, showAchievementsOnProfile);
    },
  );

  app.post(
    '/api/v1/admin/achievements',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('achievement:manage'),
      ],
    },
    async (request, reply) => {
      const body = createAchievementSchema.parse(request.body);
      const res = await deps.achievementsService.createAchievementDefinition(
        request.auth!,
        body,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/admin/achievements/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('achievement:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateAchievementSchema.parse(request.body);
      return deps.achievementsService.updateAchievementDefinition(
        request.auth!,
        id,
        body,
        request.ip,
      );
    },
  );
}
