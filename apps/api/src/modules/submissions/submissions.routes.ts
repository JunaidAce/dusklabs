import { submitFlagSchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../../middleware/auth.js';
import { sha256Hex } from '../../utils/crypto.js';
import type { SubmissionsService } from './submissions.service.js';

export function registerSubmissionRoutes(
  app: FastifyInstance,
  deps: {
    submissionsService: SubmissionsService;
    submitRateLimitMax: number;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.post(
    '/api/v1/challenges/:idOrSlug/submit',
    {
      config: {
        rateLimit: {
          max: deps.submitRateLimitMax,
          timeWindow: '1 minute',
          keyGenerator: (req: any) => {
            const cookie = req.cookies?.[SESSION_COOKIE_NAME];
            const actorKey = typeof cookie === 'string' && cookie ? sha256Hex(cookie) : req.ip;
            const target = req.params?.idOrSlug ?? req.url;
            return `submit:${actorKey}:${target}`;
          },
        },
      },
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('arena:participate'),
      ],
    },
    async (request, reply) => {
      const { idOrSlug } = z.object({ idOrSlug: z.string().min(1).max(64) }).parse(request.params);
      const { flag } = submitFlagSchema.parse(request.body);
      const res = await deps.submissionsService.submitFlag(
        request.auth!,
        idOrSlug,
        flag,
        request.ip,
      );
      return reply.status(200).send(res);
    },
  );
}
