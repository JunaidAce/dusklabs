import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { sha256Hex } from '../../utils/crypto.js';
import { ConflictError } from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';

export const DEFAULT_PLATFORM_SETTINGS = {
  platformName: 'DuskLabs',
  tagline: 'Where Curiosity Meets Exploitation',
  registrationEnabled: true,
  registrationCode: null as string | null,
  requireEmailVerificationForLogin: false,
  teamCreationEnabled: true,
  defaultMaxTeamSize: 20,
  flagSubmissionMaxAttemptsPerMin: 5,
  maintenanceMode: false,
  maintenanceMessage: null as string | null,
  contactFormEnabled: true,
  scoreboardVisible: true,
  challengesVisible: true,
};

export function toAdminSettingsView<T extends { registrationCode: string | null }>(
  settings: T,
): Omit<T, 'registrationCode'> & { registrationCodeSet: boolean } {
  const { registrationCode, ...rest } = settings;
  return { ...rest, registrationCodeSet: Boolean(registrationCode) };
}

export class PlatformSettingsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  async getSettings() {
    const existing = await this.prisma.platformSettings.findUnique({
      where: { id: 'default' },
      include: { updatedBy: { select: { id: true, username: true } } },
    });
    if (existing) return existing;

    return this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', ...DEFAULT_PLATFORM_SETTINGS },
      include: { updatedBy: { select: { id: true, username: true } } },
    });
  }

  async getPublicSettings() {
    const s = await this.getSettings();
    return {
      settings: {
        platformName: s.platformName,
        tagline: s.tagline,
        registrationEnabled: s.registrationEnabled,
        registrationCodeRequired: Boolean(s.registrationCode),
        teamCreationEnabled: s.teamCreationEnabled,
        maintenanceMode: s.maintenanceMode,
        maintenanceMessage: s.maintenanceMessage,
        contactFormEnabled: s.contactFormEnabled,
        scoreboardVisible: s.scoreboardVisible,
        challengesVisible: s.challengesVisible,
      },
    };
  }

  async updateSettings(
    actor: AuthenticatedContext,
    input: Partial<typeof DEFAULT_PLATFORM_SETTINGS>,
    meta: { correlationId?: string; ipAddress?: string },
  ) {
    const current = await this.getSettings();

    const normalized: Partial<typeof DEFAULT_PLATFORM_SETTINGS> = { ...input };
    if (typeof input.registrationCode === 'string') {
      const code = input.registrationCode.trim();
      normalized.registrationCode = code ? sha256Hex(code) : null;
    }

    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(normalized)) {
      if (v !== undefined && (current as any)[k] !== v) {
        previousValues[k] = (current as any)[k];
        newValues[k] = v;
      }
    }

    const cas = await this.prisma.platformSettings.updateMany({
      where: { id: 'default', version: current.version },
      data: {
        ...normalized,
        updatedById: actor.userId,
        version: { increment: 1 },
      },
    });

    if (cas.count !== 1) {
      throw new ConflictError('Settings were updated concurrently; refresh and retry');
    }

    const updated = await this.getSettings();

    await this.audit.record({
      actorId: actor.userId,
      actorRole: actor.roles.join(','),
      category: 'SYSTEM',
      action: 'PLATFORM_SETTINGS_UPDATED',
      entityType: 'PlatformSettings',
      entityId: 'default',
      previousValues,
      newValues,
      correlationId: meta.correlationId,
      ipAddress: meta.ipAddress,
    });

    return { settings: toAdminSettingsView(updated) };
  }

  async resetToDefaults(
    actor: AuthenticatedContext,
    meta: { correlationId?: string; ipAddress?: string },
  ) {
    return this.updateSettings(actor, DEFAULT_PLATFORM_SETTINGS, meta);
  }
}
