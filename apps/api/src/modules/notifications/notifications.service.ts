import type { NotificationType } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import type { EmailNotificationAdapter } from './emailAdapter.js';

export class NotificationsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly emailAdapter: EmailNotificationAdapter,
    private readonly logError: (err: unknown, msg: string) => void = () => {},
  ) {}

  async dispatchToUsers(params: {
    userIds: string[];
    type: NotificationType;
    title: string;
    message: string;
    linkUrl?: string;
    dedupeKey?: string;
    sendEmail?: boolean;
  }): Promise<{ createdCount: number }> {
    const uniqueUserIds = Array.from(new Set(params.userIds));
    if (uniqueUserIds.length === 0) return { createdCount: 0 };

    let targetUserIds = uniqueUserIds;

    // Cross-DB (PostgreSQL + SQLite) deduplication without SQL-dialect-specific skipDuplicates
    if (params.dedupeKey) {
      const existing = await this.prisma.notification.findMany({
        where: {
          dedupeKey: params.dedupeKey,
          userId: { in: uniqueUserIds },
        },
        select: { userId: true },
      });
      const alreadySent = new Set(existing.map((e) => e.userId));
      targetUserIds = uniqueUserIds.filter((id) => !alreadySent.has(id));
    }

    if (targetUserIds.length === 0) return { createdCount: 0 };

    let createdCount = 0;
    for (const userId of targetUserIds) {
      try {
        await this.prisma.notification.create({
          data: {
            userId,
            type: params.type,
            title: params.title,
            message: params.message,
            linkUrl: params.linkUrl ?? null,
            dedupeKey: params.dedupeKey ?? null,
          },
        });
        createdCount++;
      } catch (err: any) {
        // Ignore unique constraint collision on concurrent duplicate dispatch
        if (err?.code !== 'P2002') {
          this.logError(err, `Failed persisting notification for user ${userId}`);
        }
      }
    }

    if (params.sendEmail && createdCount > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: targetUserIds }, accountStatus: 'ACTIVE', deletedAt: null },
        select: { email: true },
      });
      for (const u of users) {
        await this.emailAdapter
          .send({
            to: u.email,
            subject: `[DuskLabs] ${params.title}`,
            textBody: params.message,
          })
          .catch((err) => this.logError(err, 'Email notification adapter error'));
      }
    }

    return { createdCount };
  }

  async notifyCompetitionParticipants(params: {
    competitionId: string;
    type: NotificationType;
    title: string;
    message: string;
    linkUrl: string;
    dedupeKey: string;
  }) {
    const regs = await this.prisma.competitionRegistration.findMany({
      where: { competitionId: params.competitionId, status: 'CONFIRMED' },
      select: { userId: true },
    });
    return this.dispatchToUsers({
      userIds: regs.map((r) => r.userId),
      type: params.type,
      title: params.title,
      message: params.message,
      linkUrl: params.linkUrl,
      dedupeKey: params.dedupeKey,
      sendEmail: true,
    });
  }

  async listUserNotifications(
    userId: string,
    query: { unreadOnly?: boolean; page?: number; limit?: number },
  ) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));

    const where = {
      userId,
      ...(query.unreadOnly ? { isRead: false } : {}),
    };

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          linkUrl: true,
          isRead: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return {
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    const existing = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!existing) throw new NotFoundError('Notification not found');
    if (existing.userId !== userId) {
      throw new ForbiddenError('Cannot modify another user notification');
    }

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true, readAt: existing.readAt ?? new Date() },
      select: { id: true, isRead: true, readAt: true },
    });
    return { notification: updated };
  }

  async markAllAsRead(userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { markedCount: res.count };
  }
}
