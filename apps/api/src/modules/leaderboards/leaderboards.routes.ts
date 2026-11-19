import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError } from '../../utils/errors.js';
import type { PlatformSettingsService } from '../settings/settings.service.js';
import type { LeaderboardsService } from './leaderboards.service.js';

const leaderboardQuerySchema = z.object({
  type: z.enum(['INDIVIDUAL', 'TEAM']).default('INDIVIDUAL'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function canViewHiddenScoreboard(auth: any): boolean {
  if (!auth) return false;
  const perms = auth.permissions as Set<string> | undefined;
  return Boolean(
    perms?.has('analytics:export') ||
      perms?.has('challenge:create') ||
      perms?.has('submission:inspect') ||
      perms?.has('competition:manage') ||
      perms?.has('audit:logs:read') ||
      perms?.has('user:manage'),
  );
}

export function registerLeaderboardRoutes(
  app: FastifyInstance,
  deps: {
    leaderboardsService: LeaderboardsService;
    settingsService: PlatformSettingsService;
    attachSession: (req: any) => Promise<void>;
  },
) {
  app.get(
    '/api/v1/leaderboards/global',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const settings = await deps.settingsService.getSettings();
      if (!settings.scoreboardVisible && !canViewHiddenScoreboard(request.auth)) {
        throw new ForbiddenError('Scoreboard is currently hidden by platform settings.');
      }
      const q = leaderboardQuerySchema.parse(request.query);
      return deps.leaderboardsService.getGlobalLeaderboard({
        entityType: q.type,
        page: q.page,
        limit: q.limit,
        viewerUserId: request.auth?.userId,
      });
    },
  );

  app.get(
    '/api/v1/leaderboards/competitions/:slug',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const settings = await deps.settingsService.getSettings();
      if (!settings.scoreboardVisible && !canViewHiddenScoreboard(request.auth)) {
        throw new ForbiddenError('Scoreboard is currently hidden by platform settings.');
      }
      const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
      const q = leaderboardQuerySchema.parse(request.query);
      return deps.leaderboardsService.getCompetitionLeaderboard({
        slug,
        entityType: q.type,
        page: q.page,
        limit: q.limit,
        auth: request.auth,
      });
    },
  );

  app.get(
    '/api/v1/leaderboards/categories',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const settings = await deps.settingsService.getSettings();
      if (!settings.scoreboardVisible && !canViewHiddenScoreboard(request.auth)) {
        throw new ForbiddenError('Scoreboard is currently hidden by platform settings.');
      }
      const { competitionId } = z
        .object({ competitionId: z.string().cuid().optional() })
        .parse(request.query);
      return deps.leaderboardsService.getCategoryStats(competitionId);
    },
  );
}
