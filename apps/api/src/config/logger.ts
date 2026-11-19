import type { PinoLoggerOptions } from 'fastify/types/logger.js';
import type { Env } from './env.js';

export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.flag',
  '*.flagValue',
  '*.token',
  '*.csrfSecret',
  '*.emailVerifyTokenHash',
  '*.passwordResetTokenHash',
];

export function buildLoggerOptions(env: Env): PinoLoggerOptions {
  return {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    redact: {
      paths: REDACTED_LOG_PATHS,
      censor: '[REDACTED]',
    },
  };
}
