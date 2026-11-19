import { manageRegistrationSchema, teamRegistrationSchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RegistrationsService } from './registrations.service.js';

export function registerRegistrationRoutes(
  app: FastifyInstance,
  deps: {
    registrationsService: RegistrationsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.post(
    '/api/v1/competitions/:id/register/individual',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('arena:participate'),
      ],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const res = await deps.registrationsService.registerIndividual(request.auth!, id, request.ip);
      return reply.status(201).send(res);
    },
  );

  app.post(
    '/api/v1/competitions/:id/register/team',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('arena:participate'),
      ],
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const { teamId } = teamRegistrationSchema.parse(request.body);
      const res = await deps.registrationsService.registerTeam(
        request.auth!,
        id,
        teamId,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.post(
    '/api/v1/competitions/:id/register/cancel',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('arena:participate'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.registrationsService.cancelRegistration(request.auth!, id, request.ip);
    },
  );

  app.get(
    '/api/v1/competitions/:id/register/status',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.registrationsService.getMyRegistrationStatus(request.auth!, id);
    },
  );

  app.get(
    '/api/v1/registrations/my',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => deps.registrationsService.getMyRegistrationHistory(request.auth!.userId),
  );

  app.get(
    '/api/v1/admin/competitions/:id/registrations',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      return deps.registrationsService.listCompetitionRegistrationsAdmin(request.auth!, id);
    },
  );

  app.patch(
    '/api/v1/admin/competitions/:id/registrations/:regId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('competition:manage'),
      ],
    },
    async (request) => {
      const { id, regId } = z
        .object({ id: z.string().cuid(), regId: z.string().cuid() })
        .parse(request.params);
      const body = manageRegistrationSchema.parse(request.body);
      return deps.registrationsService.manageRegistrationStatus(
        request.auth!,
        id,
        regId,
        body,
        request.ip,
      );
    },
  );
}
