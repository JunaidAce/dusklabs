import {
  configureFlagSchema,
  createCategorySchema,
  createChallengeSchema,
  Difficulties,
  testFlagSchema,
  transitionChallengeSchema,
  updateCategorySchema,
  updateChallengeSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ForbiddenError } from '../../utils/errors.js';
import type { PlatformSettingsService } from '../settings/settings.service.js';
import type { ChallengesService } from './challenges.service.js';

export function registerChallengeRoutes(
  app: FastifyInstance,
  deps: {
    challengesService: ChallengesService;
    settingsService: PlatformSettingsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  const canViewHiddenChallenges = (auth: any) => {
    if (!auth) return false;
    const perms = auth.permissions as Set<string> | undefined;
    return Boolean(
      perms?.has('challenge:create') ||
        perms?.has('challenge:edit') ||
        perms?.has('challenge:publish') ||
        perms?.has('submission:inspect') ||
        perms?.has('competition:manage') ||
        perms?.has('user:manage') ||
        perms?.has('audit:logs:read'),
    );
  };
  app.get('/api/v1/categories', async () => deps.challengesService.listCategories());

  app.post(
    '/api/v1/categories',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('category:manage'),
      ],
    },
    async (request, reply) => {
      const body = createCategorySchema.parse(request.body);
      const res = await deps.challengesService.createCategory(request.auth!.userId, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/categories/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('category:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateCategorySchema.parse(request.body);
      return deps.challengesService.updateCategory(id, request.auth!.userId, body, request.ip);
    },
  );

  app.delete(
    '/api/v1/categories/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('category:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.challengesService.deleteCategory(id, request.auth!.userId, request.ip);
    },
  );

  app.get(
    '/api/v1/challenges',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const settings = await deps.settingsService.getSettings();
      if (!settings.challengesVisible && !canViewHiddenChallenges(request.auth)) {
        throw new ForbiddenError('Challenges are currently hidden by platform settings.');
      }
      const query = z
        .object({
          search: z.string().max(80).optional(),
          category: z.string().max(64).optional(),
          difficulty: z.enum(Difficulties).optional(),
          tag: z.string().max(32).optional(),
          competitionSlug: z.string().max(64).optional(),
          sort: z.enum(['newest', 'points_asc', 'points_desc', 'title']).optional(),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.challengesService.listPublicChallenges(query, request.auth?.userId);
    },
  );

  app.get(
    '/api/v1/challenges/:slug',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const settings = await deps.settingsService.getSettings();
      if (!settings.challengesVisible && !canViewHiddenChallenges(request.auth)) {
        throw new ForbiddenError('Challenges are currently hidden by platform settings.');
      }
      const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
      return deps.challengesService.getPublicChallengeBySlug(slug, request.auth?.userId);
    },
  );

  app.get(
    '/api/v1/admin/challenges',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('challenge:create'),
      ],
    },
    async (request) => {
      const { status } = z.object({ status: z.string().optional() }).parse(request.query);
      return deps.challengesService.listAdminChallenges(request.auth!, status);
    },
  );

  app.get(
    '/api/v1/admin/challenges/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.challengesService.getAdminChallengeById(request.auth!, id);
    },
  );

  app.post(
    '/api/v1/challenges',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:create'),
      ],
    },
    async (request, reply) => {
      const body = createChallengeSchema.parse(request.body);
      const res = await deps.challengesService.createChallenge(request.auth!, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/challenges/:id',
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
      const body = updateChallengeSchema.parse(request.body);
      return deps.challengesService.updateChallenge(request.auth!, id, body, request.ip);
    },
  );

  app.post(
    '/api/v1/challenges/:id/transition',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:publish'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { targetStatus } = transitionChallengeSchema.parse(request.body);
      return deps.challengesService.transitionChallenge(request.auth!, id, targetStatus, request.ip);
    },
  );

  app.delete(
    '/api/v1/challenges/:id',
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
      return deps.challengesService.deleteChallenge(request.auth!, id, request.ip);
    },
  );

  app.put(
    '/api/v1/challenges/:id/flag',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:flag:configure'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = configureFlagSchema.parse(request.body);
      return deps.challengesService.configureFlag(request.auth!, id, body, request.ip);
    },
  );

  app.post(
    '/api/v1/challenges/:id/test-flag',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:flag:configure'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = testFlagSchema.parse(request.body);
      return deps.challengesService.testFlag(request.auth!, id, body);
    },
  );
}
