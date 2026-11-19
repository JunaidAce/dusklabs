import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE_NAME } from '../../middleware/auth.js';
import type { AuthService } from './auth.service.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    authService: AuthService;
    isProduction: boolean;
    authRateLimitMax: number;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
  },
) {
  const authRateConfig = {
    config: {
      rateLimit: {
        max: deps.authRateLimitMax,
        timeWindow: '15 minutes',
      },
    },
  };

  app.post('/api/v1/auth/register', authRateConfig, async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const result = await deps.authService.register(body, request.ip);
    return reply.status(201).send(result);
  });

  app.post('/api/v1/auth/verify-email', authRateConfig, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(32).max(256) }).parse(request.body);
    const result = await deps.authService.verifyEmail(token, request.ip);
    return reply.status(200).send(result);
  });

  app.post('/api/v1/auth/login', authRateConfig, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await deps.authService.login(body, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    reply.setCookie(SESSION_COOKIE_NAME, result.rawSessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.isProduction,
      path: '/',
      expires: result.expiresAt,
    });

    return reply.status(200).send({
      user: result.user,
      csrfToken: result.csrfSecret,
    });
  });

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [deps.attachSession, deps.requireAuth, deps.requireCsrf] },
    async (request, reply) => {
      await deps.authService.logout(request.auth!.sessionId, request.auth!.userId, request.ip);
      reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      return reply.status(200).send({ loggedOut: true });
    },
  );

  app.get(
    '/api/v1/auth/me',
    { preHandler: [deps.attachSession, deps.requireAuth] },
    async (request, reply) => {
      return reply.status(200).send({
        user: {
          id: request.auth!.userId,
          username: request.auth!.username,
          displayName: request.auth!.displayName,
          email: request.auth!.email,
          roles: request.auth!.roles,
          permissions: Array.from(request.auth!.permissions),
        },
        csrfToken: request.auth!.csrfSecret,
      });
    },
  );

  app.post('/api/v1/auth/forgot-password', authRateConfig, async (request, reply) => {
    const { email } = forgotPasswordSchema.parse(request.body);
    const result = await deps.authService.forgotPassword(email, request.ip);
    return reply.status(200).send(result);
  });

  app.post('/api/v1/auth/reset-password', authRateConfig, async (request, reply) => {
    const { token, newPassword } = resetPasswordSchema.parse(request.body);
    const result = await deps.authService.resetPassword(token, newPassword, request.ip);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.status(200).send(result);
  });
}
