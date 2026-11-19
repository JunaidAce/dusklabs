import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { loadEnv, type Env } from './config/env.js';
import { buildLoggerOptions } from './config/logger.js';
import { createPrismaClient } from './config/prisma.js';
import { createAuthMiddleware, SESSION_COOKIE_NAME } from './middleware/auth.js';
import { sha256Hex } from './utils/crypto.js';
import { AuditService } from './modules/audit/audit.service.js';
import { registerAuditRoutes } from './modules/audit/audit.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { TeamsService } from './modules/teams/teams.service.js';
import { registerTeamRoutes } from './modules/teams/teams.routes.js';
import { ChallengesService } from './modules/challenges/challenges.service.js';
import { registerChallengeRoutes } from './modules/challenges/challenges.routes.js';
import { AttachmentsService } from './modules/attachments/attachments.service.js';
import { registerAttachmentRoutes } from './modules/attachments/attachments.routes.js';
import { ScoringService } from './modules/scoring/scoring.service.js';
import { registerScoringRoutes } from './modules/scoring/scoring.routes.js';
import { InMemoryDevEmailAdapter } from './modules/notifications/emailAdapter.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { registerNotificationRoutes } from './modules/notifications/notifications.routes.js';
import { AnnouncementsService } from './modules/announcements/announcements.service.js';
import { registerAnnouncementRoutes } from './modules/announcements/announcements.routes.js';
import { AchievementsService } from './modules/achievements/achievements.service.js';
import { registerAchievementRoutes } from './modules/achievements/achievements.routes.js';
import { CompetitionsService } from './modules/competitions/competitions.service.js';
import { registerCompetitionRoutes } from './modules/competitions/competitions.routes.js';
import { RegistrationsService } from './modules/competitions/registrations.service.js';
import { registerRegistrationRoutes } from './modules/competitions/registrations.routes.js';
import { CompetitionLifecycleScheduler } from './modules/competitions/competitionScheduler.js';
import { SubmissionsService } from './modules/submissions/submissions.service.js';
import { registerSubmissionRoutes } from './modules/submissions/submissions.routes.js';
import { HintsService } from './modules/hints/hints.service.js';
import { registerHintRoutes } from './modules/hints/hints.routes.js';
import { LeaderboardsService } from './modules/leaderboards/leaderboards.service.js';
import { registerLeaderboardRoutes } from './modules/leaderboards/leaderboards.routes.js';
import { ContactService } from './modules/contact/contact.service.js';
import { registerContactRoutes } from './modules/contact/contact.routes.js';
import { AdminOverviewService } from './modules/admin/adminOverview.service.js';
import { registerAdminOverviewRoutes } from './modules/admin/adminOverview.routes.js';
import { AdminUsersService } from './modules/admin/adminUsers.service.js';
import { registerAdminUserRoutes } from './modules/admin/adminUsers.routes.js';
import { ModerationService } from './modules/moderation/moderation.service.js';
import { registerModerationRoutes } from './modules/moderation/moderation.routes.js';
import { AnalyticsService } from './modules/analytics/analytics.service.js';
import { registerAnalyticsRoutes } from './modules/analytics/analytics.routes.js';
import { PlatformSettingsService } from './modules/settings/settings.service.js';
import { registerSettingsRoutes } from './modules/settings/settings.routes.js';
import { registerSecurityPlugins } from './plugins/security.js';
import { registerErrorHandler } from './utils/errors.js';

export interface BuildAppOptions {
  env?: Env;
  prisma?: PrismaClient;
  authRateLimitMax?: number;
  globalRateLimitMax?: number;
  submitRateLimitMax?: number;
  contactRateLimitMax?: number;
  enableScheduler?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const env = options.env ?? loadEnv();
  const prisma = options.prisma ?? createPrismaClient();
  const isProduction = env.NODE_ENV === 'production';
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

  const app = Fastify({
    logger: buildLoggerOptions(env),
  });

  await registerSecurityPlugins(app, env, options.globalRateLimitMax ?? 120);

  app.setErrorHandler((err, req, rep) => registerErrorHandler(err, req, rep, isProduction));

  const auditService = new AuditService(prisma);
  const settingsService = new PlatformSettingsService(prisma, auditService);
  const authService = new AuthService(prisma, auditService, !isProduction, undefined, settingsService);
  const { attachSession, requireAuth, requireCsrf, requirePermission } = createAuthMiddleware(
    prisma,
    allowedOrigins,
  );

  // CTFd-like maintenance mode gate (bypass for admins/settings managers so the site can be recovered)
  app.addHook('onRequest', async (request, reply) => {
    const url = request.raw.url || '';
    if (!url.startsWith('/api/')) return;
    if (
      url.startsWith('/api/v1/health') ||
      url.startsWith('/api/v1/auth/') ||
      url.startsWith('/api/v1/settings/public')
    ) {
      return;
    }

    let settings: { maintenanceMode: boolean; maintenanceMessage: string | null } | null = null;
    try {
      const s = await settingsService.getSettings();
      settings = { maintenanceMode: s.maintenanceMode, maintenanceMessage: s.maintenanceMessage };
    } catch {
      return; // don't block requests if settings lookup fails unexpectedly
    }
    if (!settings.maintenanceMode) return;

    const rawToken = (request.cookies as any)?.[SESSION_COOKIE_NAME];
    if (typeof rawToken === 'string' && rawToken) {
      try {
        const tokenHash = sha256Hex(rawToken);
        const session = await prisma.session.findUnique({
          where: { tokenHash },
          include: {
            user: {
              include: {
                roles: {
                  include: {
                    role: {
                      include: { permissions: { include: { permission: true } } },
                    },
                  },
                },
              },
            },
          },
        });
        if (session && !session.revokedAt && session.expiresAt.getTime() > Date.now() && session.user.accountStatus === 'ACTIVE' && !session.user.deletedAt) {
          const roleNames = session.user.roles.map((ur) => ur.role.name);
          const permKeys = new Set(session.user.roles.flatMap((ur) => ur.role.permissions.map((rp) => rp.permission.key)));
          const isAdminBypass =
            roleNames.includes('SUPER_ADMIN') ||
            roleNames.includes('PLATFORM_ADMIN') ||
            permKeys.has('platform:settings:manage') ||
            permKeys.has('user:manage');
          if (isAdminBypass) return;
        }
      } catch {
        // fall through to maintenance block
      }
    }

    return reply.status(503).send({
      error: 'MAINTENANCE_MODE',
      message: settings.maintenanceMessage || 'The platform is currently undergoing maintenance. Please try again later.',
    });
  });

  app.get('/api/v1/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', service: 'dusklabs-api' };
  });

  registerAuthRoutes(app, {
    authService,
    isProduction,
    authRateLimitMax: options.authRateLimitMax ?? 10,
    attachSession,
    requireAuth,
    requireCsrf,
  });

  registerDashboardRoutes(app, { prisma, attachSession, requireAuth });

  const teamsService = new TeamsService(prisma, auditService, settingsService);
  registerTeamRoutes(app, { teamsService, attachSession, requireAuth, requireCsrf });

  const challengesService = new ChallengesService(prisma, auditService, {
    encryptionKeyHex: env.FLAG_ENCRYPTION_KEY,
    hmacPepper: env.FLAG_HMAC_PEPPER,
  });
  registerChallengeRoutes(app, {
    challengesService,
    settingsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const attachmentsService = new AttachmentsService(
    prisma,
    auditService,
    {
      uploadDir: env.UPLOAD_DIR,
      maxFileBytes: env.MAX_ATTACHMENT_BYTES,
      rustUrl: env.RUST_ATTACHMENT_URL,
      rustInternalToken: env.RUST_INTERNAL_TOKEN,
      rustTimeoutMs: env.RUST_TIMEOUT_MS,
      allowTsFallback: env.ALLOW_TS_ATTACHMENT_FALLBACK,
    },
    (msg, meta) => app.log.warn({ msg, ...(meta ?? {}) }),
  );
  registerAttachmentRoutes(app, {
    attachmentsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const scoringService = new ScoringService(prisma, auditService);
  registerScoringRoutes(app, {
    scoringService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const emailAdapter = new InMemoryDevEmailAdapter();
  const notificationsService = new NotificationsService(
    prisma,
    emailAdapter,
    (err, msg) => app.log.error(err, msg),
  );
  registerNotificationRoutes(app, {
    notificationsService,
    attachSession,
    requireAuth,
    requireCsrf,
  });

  const announcementsService = new AnnouncementsService(prisma, auditService, notificationsService);
  registerAnnouncementRoutes(app, {
    announcementsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const achievementsService = new AchievementsService(
    prisma,
    auditService,
    notificationsService,
    scoringService,
  );
  registerAchievementRoutes(app, {
    achievementsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const competitionsService = new CompetitionsService(
    prisma,
    auditService,
    notificationsService,
    achievementsService,
  );
  registerCompetitionRoutes(app, {
    competitionsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const registrationsService = new RegistrationsService(prisma, auditService, notificationsService);
  registerRegistrationRoutes(app, {
    registrationsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const submissionsService = new SubmissionsService(
    prisma,
    auditService,
    {
      encryptionKeyHex: env.FLAG_ENCRYPTION_KEY,
      hmacPepper: env.FLAG_HMAC_PEPPER,
    },
    scoringService,
    achievementsService,
  );
  registerSubmissionRoutes(app, {
    submissionsService,
    submitRateLimitMax: options.submitRateLimitMax ?? 5,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const hintsService = new HintsService(prisma, auditService);
  registerHintRoutes(app, {
    hintsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const leaderboardsService = new LeaderboardsService(prisma, scoringService);
  registerLeaderboardRoutes(app, { leaderboardsService, settingsService, attachSession });

  const contactService = new ContactService(prisma, auditService, env.SESSION_SECRET, settingsService);
  registerContactRoutes(app, {
    contactService,
    contactRateLimitMax: options.contactRateLimitMax ?? 5,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const adminOverviewService = new AdminOverviewService(prisma);
  registerAdminOverviewRoutes(app, {
    adminOverviewService,
    attachSession,
    requireAuth,
    requirePermission,
  });

  const adminUsersService = new AdminUsersService(prisma, auditService);
  registerAdminUserRoutes(app, {
    adminUsersService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const moderationService = new ModerationService(prisma, auditService);
  registerModerationRoutes(app, {
    moderationService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  registerAuditRoutes(app, { auditService, attachSession, requireAuth, requirePermission });

  const analyticsService = new AnalyticsService(prisma, auditService, scoringService);
  registerAnalyticsRoutes(app, { analyticsService, attachSession, requireAuth, requirePermission });

  registerSettingsRoutes(app, {
    settingsService,
    attachSession,
    requireAuth,
    requireCsrf,
    requirePermission,
  });

  const lifecycleScheduler = new CompetitionLifecycleScheduler(
    prisma,
    competitionsService,
    (err, msg) => app.log.error(err, msg),
  );
  if (options.enableScheduler ?? env.NODE_ENV !== 'test') {
    lifecycleScheduler.start();
  }

  app.get(
    '/api/v1/admin/ping',
    { preHandler: [attachSession, requireAuth, requirePermission('audit:logs:read')] },
    async (request) => ({
      authorized: true,
      userId: request.auth!.userId,
      roles: request.auth!.roles,
    }),
  );

  app.addHook('onClose', async () => {
    lifecycleScheduler.stop();
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return { app, prisma, authService, auditService, scoringService, lifecycleScheduler };
}
