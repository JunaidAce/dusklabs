import {
  createTeamSchema,
  inviteMemberSchema,
  joinByCodeSchema,
  joinRequestSchema,
  respondInvitationSchema,
  transferCaptainSchema,
  updateTeamSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TeamsService } from './teams.service.js';

export function registerTeamRoutes(
  app: FastifyInstance,
  deps: {
    teamsService: TeamsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
  },
) {
  app.get('/api/v1/teams', async (request) => {
    const query = z
      .object({
        search: z.string().max(64).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .parse(request.query);
    return deps.teamsService.listTeams(query);
  });

  app.get(
    '/api/v1/teams/my',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => deps.teamsService.getMyTeams(request.auth!.userId),
  );

  app.get(
    '/api/v1/teams/:slug',
    { preHandler: [deps.attachSession] },
    async (request) => {
      const { slug } = z.object({ slug: z.string().min(1).max(80) }).parse(request.params);
      return deps.teamsService.getTeamBySlug(slug, request.auth?.userId);
    },
  );

  app.post(
    '/api/v1/teams',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request, reply) => {
      const body = createTeamSchema.parse(request.body);
      const res = await deps.teamsService.createTeam(request.auth!.userId, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.patch(
    '/api/v1/teams/:id',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateTeamSchema.parse(request.body);
      return deps.teamsService.updateTeam(id, request.auth!.userId, body, request.ip);
    },
  );

  app.post(
    '/api/v1/teams/:id/invite-code/regenerate',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.teamsService.regenerateInviteCode(id, request.auth!.userId, request.ip);
    },
  );

  app.post(
    '/api/v1/teams/:id/invitations',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = inviteMemberSchema.parse(request.body);
      const res = await deps.teamsService.inviteMember(id, request.auth!.userId, body, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.post(
    '/api/v1/teams/:id/requests',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = joinRequestSchema.parse(request.body ?? {});
      const res = await deps.teamsService.requestToJoin(
        id,
        request.auth!.userId,
        body.message,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.post(
    '/api/v1/teams/invitations/:invitationId/respond',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { invitationId } = z.object({ invitationId: z.string().cuid() }).parse(request.params);
      const { action } = respondInvitationSchema.parse(request.body);
      return deps.teamsService.respondToInvitationOrRequest(
        invitationId,
        request.auth!.userId,
        action,
        request.ip,
      );
    },
  );

  app.post(
    '/api/v1/teams/join-by-code',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { inviteCode } = joinByCodeSchema.parse(request.body);
      return deps.teamsService.joinByCode(request.auth!.userId, inviteCode, request.ip);
    },
  );

  app.delete(
    '/api/v1/teams/:id/members/:userId',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id, userId } = z
        .object({ id: z.string().cuid(), userId: z.string().cuid() })
        .parse(request.params);
      return deps.teamsService.removeMember(id, request.auth!.userId, userId, request.ip);
    },
  );

  app.post(
    '/api/v1/teams/:id/leave',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.teamsService.leaveTeam(id, request.auth!.userId, request.ip);
    },
  );

  app.post(
    '/api/v1/teams/:id/transfer-captain',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { newCaptainUserId } = transferCaptainSchema.parse(request.body);
      return deps.teamsService.transferCaptaincy(
        id,
        request.auth!.userId,
        newCaptainUserId,
        request.ip,
      );
    },
  );
}
