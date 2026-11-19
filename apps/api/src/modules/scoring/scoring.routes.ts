import { adjustScoreSchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ScoringService } from './scoring.service.js';

export function registerScoringRoutes(
  app: FastifyInstance,
  deps: {
    scoringService: ScoringService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.post(
    '/api/v1/admin/scores/adjust',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('score:adjust'),
      ],
    },
    async (request) => {
      const body = adjustScoreSchema.parse(request.body);
      return deps.scoringService.adjustScore(request.auth!, body, request.ip);
    },
  );

  app.post(
    '/api/v1/admin/competitions/:id/recalculate',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('score:adjust'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.scoringService.recalculateCompetitionScores(request.auth!, id, request.ip);
    },
  );
}
