import type { AuditCategory, RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { NotFoundError } from '../../utils/errors.js';

const SENSITIVE_KEY_PATTERN =
  /password|passhash|secret|token|cookie|flag|apikey|api_key|authorization|privatekey|private_key|salt|pepper|digest|encrypted/i;

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function safeSerializeJson(input?: Record<string, unknown> | null): string | null {
  if (!input) return null;
  return JSON.stringify(redactSensitiveValue(input));
}

function safeParseAndRedactJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const redacted = redactSensitiveValue(parsed);
    return typeof redacted === 'object' && redacted !== null
      ? (redacted as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function inferAuditCategory(action: string): AuditCategory {
  if (action.startsWith('AUTH_')) return 'AUTH';
  if (action.startsWith('USER_')) return 'USER_ADMIN';
  if (action.startsWith('COMPETITION_')) return 'COMPETITION';
  if (
    action.startsWith('CHALLENGE_') ||
    action.startsWith('CATEGORY_') ||
    action.startsWith('HINT_')
  ) {
    return 'CHALLENGE';
  }
  if (action.startsWith('SCORE_')) return 'SCORING';
  if (
    action.startsWith('MODERATION_') ||
    action.startsWith('SUBMISSION_DISPUTE_') ||
    action.startsWith('CONTACT_')
  ) {
    return 'MODERATION';
  }
  if (action.startsWith('TEAM_')) return 'TEAM';
  if (action.startsWith('ACHIEVEMENT_')) return 'ACHIEVEMENT';
  return 'SYSTEM';
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  private isSeniorAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  async record(params: {
    actorId?: string | null;
    actorRole?: string | null;
    category?: AuditCategory;
    action: string;
    entityType: string;
    entityId?: string | null;
    previousValues?: Record<string, unknown> | null;
    newValues?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    correlationId?: string | null;
    ipAddress?: string | null;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: params.actorId ?? null,
        actorRole: params.actorRole ?? (params.actorId ? null : 'SYSTEM'),
        category: params.category ?? inferAuditCategory(params.action),
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        previousValues: safeSerializeJson(params.previousValues),
        newValues: safeSerializeJson(params.newValues),
        metadata: safeSerializeJson(params.metadata),
        correlationId: params.correlationId ?? null,
        ipAddress: params.ipAddress ?? null,
      },
    });
  }

  async queryLogs(
    auth: AuthenticatedContext,
    query: {
      actor?: string;
      category?: AuditCategory;
      action?: string;
      entityType?: string;
      entityId?: string;
      startDate?: string;
      endDate?: string;
      page: number;
      limit: number;
    },
  ) {
    const showIp = this.isSeniorAdmin(auth);
    const actorFilter = query.actor?.trim();

    const where: any = {
      ...(query.category ? { category: query.category } : {}),
      ...(query.action ? { action: { contains: query.action.trim().toUpperCase() } } : {}),
      ...(query.entityType ? { entityType: query.entityType.trim() } : {}),
      ...(query.entityId ? { entityId: query.entityId.trim() } : {}),
      ...(actorFilter
        ? {
            OR: [
              { actorId: actorFilter },
              { actor: { username: { contains: actorFilter } } },
            ],
          }
        : {}),
      ...((query.startDate || query.endDate) && {
        createdAt: {
          ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
          ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
        },
      }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          actor: { select: { id: true, username: true, displayName: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      logs: rows.map((row) => ({
        id: row.id,
        category: row.category,
        action: row.action,
        actor: row.actor,
        actorRole: row.actorRole,
        entityType: row.entityType,
        entityId: row.entityId,
        previousValues: safeParseAndRedactJson(row.previousValues),
        newValues: safeParseAndRedactJson(row.newValues),
        metadata: safeParseAndRedactJson(row.metadata),
        correlationId: row.correlationId,
        ipAddress: showIp ? row.ipAddress : null,
        createdAt: row.createdAt,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }

  async getLogById(auth: AuthenticatedContext, logId: string) {
    const row = await this.prisma.auditLog.findUnique({
      where: { id: logId },
      include: {
        actor: { select: { id: true, username: true, displayName: true } },
      },
    });
    if (!row) throw new NotFoundError('Audit log record not found');

    const showIp = this.isSeniorAdmin(auth);
    return {
      log: {
        id: row.id,
        category: row.category,
        action: row.action,
        actor: row.actor,
        actorRole: row.actorRole,
        entityType: row.entityType,
        entityId: row.entityId,
        previousValues: safeParseAndRedactJson(row.previousValues),
        newValues: safeParseAndRedactJson(row.newValues),
        metadata: safeParseAndRedactJson(row.metadata),
        correlationId: row.correlationId,
        ipAddress: showIp ? row.ipAddress : null,
        createdAt: row.createdAt,
      },
    };
  }
}
