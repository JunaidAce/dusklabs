import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../config/env.js';
import multipart from '@fastify/multipart';

export async function registerSecurityPlugins(
  app: FastifyInstance,
  env: Env,
  globalRateLimitMax = 120,
) {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", ...allowedOrigins],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }
      // Fastify uses error.statusCode for the HTTP response; a bare Error yields 500.
      // A disallowed Origin must surface as 403 (matches Phase 6 SEC-03 contract).
      const rejected = new Error('Origin not allowed by CORS') as Error & { statusCode?: number };
      rejected.statusCode = 403;
      cb(rejected, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: {},
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_ATTACHMENT_BYTES,
      files: 1,
      fields: 10,
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: globalRateLimitMax,
    timeWindow: '1 minute',
  });
}
