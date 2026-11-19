import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async assertCompetitionAnnouncementAccess(
    auth: AuthenticatedContext,
    competitionId: string | null,
  ) {
    if (!competitionId) {
      if (!this.isPlatformAdmin(auth)) {
        throw new ForbiddenError('Only Platform or Super Admins can manage global announcements');
      }
      return null;
    }

    const comp = await this.prisma.competition.findUnique({ where: { id: competitionId } });
    if (!comp) throw new NotFoundError('Competition not found');

    if (this.isPlatformAdmin(auth)) return comp;
    if (auth.roles.includes('COMPETITION_ORGANIZER')) {
      if (comp.createdById === auth.userId) return comp;
      const assigned = await this.prisma.competitionOrganizer.findUnique({
        where: { competitionId_userId: { competitionId, userId: auth.userId } },
      });
      if (assigned) return comp;
    }

    throw new ForbiddenError('You are not authorized to publish announcements for this competition');
  }

  async listGlobalAnnouncements() {
    const announcements = await this.prisma.announcement.findMany({
      where: { competitionId: null },
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
      take: 25,
      select: {
        id: true,
        title: true,
        body: true,
        isPinned: true,
        publishedAt: true,
        author: { select: { username: true, displayName: true } },
      },
    });
    return { announcements };
  }

  async createCompetitionAnnouncement(
    auth: AuthenticatedContext,
    competitionId: string,
    input: { title: string; body: string; isPinned: boolean },
    ipAddress?: string,
  ) {
    const comp = (await this.assertCompetitionAnnouncementAccess(auth, competitionId))!;

    const announcement = await this.prisma.announcement.create({
      data: {
        competitionId,
        authorId: auth.userId,
        title: input.title,
        body: input.body,
        isPinned: input.isPinned,
      },
      include: {
        author: { select: { username: true, displayName: true } },
      },
    });

    await this.notifications.notifyCompetitionParticipants({
      competitionId,
      type: 'ANNOUNCEMENT',
      title: `${comp.title}: ${announcement.title}`,
      message: announcement.body.slice(0, 240),
      linkUrl: `/competitions/${comp.slug}/announcements`,
      dedupeKey: `announcement:${announcement.id}`,
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'COMPETITION_ANNOUNCEMENT_CREATED',
      entityType: 'Announcement',
      entityId: announcement.id,
      metadata: { competitionId, isPinned: announcement.isPinned },
      ipAddress,
    });

    return { announcement };
  }

  async createGlobalAnnouncement(
    auth: AuthenticatedContext,
    input: { title: string; body: string; isPinned: boolean },
    ipAddress?: string,
  ) {
    await this.assertCompetitionAnnouncementAccess(auth, null);

    const announcement = await this.prisma.announcement.create({
      data: {
        competitionId: null,
        authorId: auth.userId,
        title: input.title,
        body: input.body,
        isPinned: input.isPinned,
      },
      include: {
        author: { select: { username: true, displayName: true } },
      },
    });

    const activeUsers = await this.prisma.user.findMany({
      where: { accountStatus: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });

    await this.notifications.dispatchToUsers({
      userIds: activeUsers.map((u) => u.id),
      type: 'ANNOUNCEMENT',
      title: announcement.title,
      message: announcement.body.slice(0, 240),
      linkUrl: '/competitions',
      dedupeKey: `announcement:${announcement.id}`,
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'GLOBAL_ANNOUNCEMENT_CREATED',
      entityType: 'Announcement',
      entityId: announcement.id,
      ipAddress,
    });

    return { announcement };
  }

  async updateAnnouncement(
    auth: AuthenticatedContext,
    announcementId: string,
    input: { title?: string; body?: string; isPinned?: boolean },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.announcement.findUnique({ where: { id: announcementId } });
    if (!existing) throw new NotFoundError('Announcement not found');

    await this.assertCompetitionAnnouncementAccess(auth, existing.competitionId);

    const announcement = await this.prisma.announcement.update({
      where: { id: announcementId },
      data: input,
      include: { author: { select: { username: true, displayName: true } } },
    });

    await this.audit.record({
      actorId: auth.userId,
      action: 'ANNOUNCEMENT_UPDATED',
      entityType: 'Announcement',
      entityId: announcementId,
      metadata: { competitionId: existing.competitionId },
      ipAddress,
    });

    return { announcement };
  }

  async deleteAnnouncement(auth: AuthenticatedContext, announcementId: string, ipAddress?: string) {
    const existing = await this.prisma.announcement.findUnique({ where: { id: announcementId } });
    if (!existing) throw new NotFoundError('Announcement not found');

    await this.assertCompetitionAnnouncementAccess(auth, existing.competitionId);

    await this.prisma.announcement.delete({ where: { id: announcementId } });

    await this.audit.record({
      actorId: auth.userId,
      action: 'ANNOUNCEMENT_DELETED',
      entityType: 'Announcement',
      entityId: announcementId,
      metadata: { competitionId: existing.competitionId },
      ipAddress,
    });

    return { deleted: true };
  }
}
