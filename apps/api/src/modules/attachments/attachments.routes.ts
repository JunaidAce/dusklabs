import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, BadRequestError } from '../../utils/errors.js';
import type { AttachmentsService } from './attachments.service.js';

// busboy truncates the file stream at the multipart fileSize limit and only emits a
// 'limit' event; for fully-buffered bodies (fastify.inject, small uploads) the limit
// is reached during parsing — before any consumer listener can attach — and the
// truncated stream then ends "cleanly" at exactly the limit size. The part's
// `truncated` flag (set synchronously by busboy) is therefore checked when the part
// resolves, and a 'limit' listener covers the streaming case (SEC-09: 413, not 201).
type MultipartFileSizeGuard = {
  truncated: boolean;
  on(event: 'limit', listener: () => void): unknown;
  destroy?: (err?: Error) => void;
};

function rejectOversizePart(file: MultipartFileSizeGuard): void {
  file.destroy?.(new AppError(413, 'FILE_TOO_LARGE', 'Uploaded file exceeds maximum allowed size.'));
}

function enforceMultipartFileSizeLimit(file: MultipartFileSizeGuard): void {
  if (file.truncated) {
    rejectOversizePart(file);
    throw new AppError(413, 'FILE_TOO_LARGE', 'Uploaded file exceeds maximum allowed size.');
  }
  file.on('limit', () => rejectOversizePart(file));
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  deps: {
    attachmentsService: AttachmentsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.post(
    '/api/v1/challenges/:id/attachments',
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
      const data = await request.file();
      if (!data) throw new BadRequestError('Multipart file upload is required');
      enforceMultipartFileSizeLimit(data.file);
      const res = await deps.attachmentsService.uploadAttachment(
        request.auth!,
        id,
        data.file,
        data.filename,
        request.ip,
      );
      return reply.status(201).send(res);
    },
  );

  app.put(
    '/api/v1/challenges/:id/attachments/:attId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id, attId } = z
        .object({ id: z.string().cuid(), attId: z.string().cuid() })
        .parse(request.params);
      const data = await request.file();
      if (!data) throw new BadRequestError('Multipart file upload is required');
      enforceMultipartFileSizeLimit(data.file);
      return deps.attachmentsService.replaceAttachment(
        request.auth!,
        id,
        attId,
        data.file,
        data.filename,
        request.ip,
      );
    },
  );

  app.delete(
    '/api/v1/challenges/:id/attachments/:attId',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('challenge:edit'),
      ],
    },
    async (request) => {
      const { id, attId } = z
        .object({ id: z.string().cuid(), attId: z.string().cuid() })
        .parse(request.params);
      return deps.attachmentsService.deleteAttachment(request.auth!, id, attId, request.ip);
    },
  );

  app.get(
    '/api/v1/challenges/:slug/attachments',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request) => {
      const { slug } = z.object({ slug: z.string().min(1).max(64) }).parse(request.params);
      return deps.attachmentsService.listChallengeAttachments(request.auth!, slug);
    },
  );

  app.get(
    '/api/v1/attachments/:attId/download',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request, reply) => {
      const { attId } = z.object({ attId: z.string().cuid() }).parse(request.params);
      const dl = await deps.attachmentsService.prepareAuthorizedDownload(request.auth!, attId);

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${dl.originalName}"`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Content-Length', String(dl.sizeBytes));
      return reply.send(dl.stream);
    },
  );
}
