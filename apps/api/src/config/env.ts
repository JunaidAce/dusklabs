import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../../.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://') || v.startsWith('file:'),
      'DATABASE_URL must be a PostgreSQL connection string or SQLite file: URI',
    ),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  FLAG_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'FLAG_ENCRYPTION_KEY must be a 64-character hex string (256-bit)'),
  FLAG_HMAC_PEPPER: z.string().min(32, 'FLAG_HMAC_PEPPER must be at least 32 characters'),
  UPLOAD_DIR: z.string().default('./apps/api/storage/attachments'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(26_214_400),
    RUST_ATTACHMENT_URL: z.string().url().default('http://127.0.0.1:4100'),
  RUST_INTERNAL_TOKEN: z.string().min(16).default('dev-internal-token-change-me'),
  RUST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
  ALLOW_TS_ATTACHMENT_FALLBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(overrides?: Partial<Record<keyof Env, string>>): Env {
  const merged = { ...process.env, ...overrides };
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}
