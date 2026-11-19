import {
  ContactCategories,
  ContactStatuses,
  createContactInquirySchema,
  updateContactInquirySchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ContactService } from './contact.service.js';

export function registerContactRoutes(
  app: FastifyInstance,
  deps: {
    contactService: ContactService;
    contactRateLimitMax: number;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.post(
    '/api/v1/contact',
    {
      config: {
        rateLimit: {
          max: deps.contactRateLimitMax,
          timeWindow: '15 minutes',
        },
      },
      preHandler: [deps.attachSession],
    },
    async (request, reply) => {
      const body = createContactInquirySchema.parse(request.body);
      const res = await deps.contactService.submitInquiry({
        userId: request.auth?.userId ?? null,
        input: body,
        ipAddress: request.ip,
      });
      return reply.status(201).send(res);
    },
  );

  app.get(
    '/api/v1/contact/my',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => deps.contactService.listMyInquiries(request.auth!.userId),
  );

  app.get(
    '/api/v1/admin/contact-inquiries',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('report:moderate'),
      ],
    },
    async (request) => {
      const query = z
        .object({
          status: z.enum(ContactStatuses).optional(),
          category: z.enum(ContactCategories).optional(),
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);
      return deps.contactService.listAdminInquiries(query);
    },
  );

  app.patch(
    '/api/v1/admin/contact-inquiries/:id',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('report:moderate'),
      ],
    },
    async (request) => {
      const { id } = z.object({ id: z.string().cuid() }).parse(request.params);
      const body = updateContactInquirySchema.parse(request.body);
      return deps.contactService.updateAdminInquiry(request.auth!.userId, id, body, request.ip);
    },
  );
}
