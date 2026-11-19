import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Invalid request', code = 'BAD_REQUEST') {
    super(400, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', code = 'FORBIDDEN') {
    super(403, code, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', code = 'CONFLICT') {
    super(409, code, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', code = 'RATE_LIMITED') {
    super(429, code, message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(503, code, message);
  }
}

export function registerErrorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  isProduction: boolean,
) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Input validation failed',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  const fastifyErr = error as FastifyError;
  if (fastifyErr.statusCode === 429) {
    return reply.status(429).send({
      error: {
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded. Please retry later.',
      },
    });
  }

if (fastifyErr.code === 'FST_REQ_FILE_TOO_LARGE' || fastifyErr.statusCode === 413) {
     return reply.status(413).send({
       error: { code: 'FILE_TOO_LARGE', message: 'Uploaded file exceeds maximum allowed size.' },
     });
   }

  // Prisma unique constraint violation
  const prismaCode = (error as { code?: string }).code;
  if (prismaCode === 'P2002') {
    return reply.status(409).send({
      error: { code: 'UNIQUE_CONSTRAINT', message: 'A record with this unique identifier already exists.' },
    });
  }
  if (prismaCode === 'P2003') {
    return reply.status(400).send({
      error: { code: 'INVALID_REFERENCE', message: 'Referenced resource does not exist.' },
    });
  }
  if (prismaCode === 'P2025') {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Requested record was not found.' },
    });
  }

  request.log.error({ err: fastifyErr }, 'Unhandled server error');
  return reply.status(fastifyErr.statusCode && fastifyErr.statusCode >= 400 ? fastifyErr.statusCode : 500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected internal error occurred.' : fastifyErr.message,
    },
  });
}
