import { updatePlatformSettingsSchema } from '@dusklabs/shared';
import type { FastifyInstance } from 'fastify';
import { toAdminSettingsView, type PlatformSettingsService } from './settings.service.js';

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: {
    settingsService: PlatformSettingsService;
    attachSession: (req: any) => Promise<void>;
    requireAuth: (req: any, rep: any) => Promise<void>;
    requireCsrf: (req: any, rep: any) => Promise<void>;
    requirePermission: (...perms: any[]) => (req: any, rep: any) => Promise<void>;
  },
) {
  app.get('/api/v1/settings/public', async () => deps.settingsService.getPublicSettings());

  app.get(
    '/api/v1/admin/settings',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requirePermission('platform:settings:manage'),
      ],
    },
    async () => ({ settings: toAdminSettingsView(await deps.settingsService.getSettings()) }),
  );

  app.patch(
    '/api/v1/admin/settings',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('platform:settings:manage'),
      ],
    },
    async (request) => {
      const body = updatePlatformSettingsSchema.parse(request.body);
      return deps.settingsService.updateSettings(request.auth!, body, {
        correlationId: request.id,
        ipAddress: request.ip,
      });
    },
  );

  app.post(
    '/api/v1/admin/settings/reset',
    {
      preHandler: [
        deps.attachSession,
        deps.requireAuth,
        deps.requireCsrf,
        deps.requirePermission('platform:settings:manage'),
      ],
    },
    async (request) =>
      deps.settingsService.resetToDefaults(request.auth!, {
        correlationId: request.id,
        ipAddress: request.ip,
      }),
  );
}
