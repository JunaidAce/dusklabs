import {
  createHintSchema,
  reorderHintsSchema,
  updateHintSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HintsService } from './hints.service.js';

export function registerHintRoutes(
  app: FastifyInstance,
  deps: {
    hintsService: HintsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/admin/challenges/:id/hints',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.hintsService.listAdminHints(request.auth!, id);
    },
  );

  app.post(
    '/api/v1/challenges/:id/hints',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = createHintSchema.parse(request.body);
      const res = await deps.hintsService.createHint(request.auth!, id, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/challenges/:id/hints/:hintId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id, hintId } = z
        .object({ id: z.string().cuid(), hintId: z.string().cuid() })
        .parse(request.params);
      const body = updateHintSchema.parse(request.body);
      return deps.hintsService.updateHint(request.auth!, id, hintId, body, request.ip);
    },
  );

  app.put(
    '/api/v1/challenges/:id/hints/reorder',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { hintIds } = reorderHintsSchema.parse(request.body);
      return deps.hintsService.reorderHints(request.auth!, id, hintIds, request.ip);
    },
  );

  app.delete(
    '/api/v1/challenges/:id/hints/:hintId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id, hintId } = z
        .object({ id: z.string().cuid(), hintId: z.string().cuid() })
        .parse(request.params);
      return deps.hintsService.deleteHint(request.auth!, id, hintId, request.ip);
    },
  );

  app.get(
    '/api/v1/challenges/:idOrSlug/hints',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const { idOrSlug } = z.object({ idOrSlug: z.string().min(1).max(64) }).parse(request.params);
      return deps.hintsService.listChallengeHintsForParticipant(idOrSlug, request.auth?.userId);
    },
  );

  app.post(
    '/api/v1/challenges/:idOrSlug/hints/:hintId/unlock',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('arena:participate'),
      ],
    },
    async (request) => {
      const { idOrSlug, hintId } = z
        .object({ idOrSlug: z.string().min(1).max(64), hintId: z.string().cuid() })
        .parse(request.params);
      return deps.hintsService.unlockHint(request.auth!, idOrSlug, hintId, request.ip);
    },
  );
}
