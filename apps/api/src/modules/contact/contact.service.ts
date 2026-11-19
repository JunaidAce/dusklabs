import type { ContactCategory, ContactStatus } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import { sha256Hex } from '../../utils/crypto.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PlatformSettingsService } from '../settings/settings.service.js';

export class ContactService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly sessionSecret: string,
    private readonly settingsService?: PlatformSettingsService,
  ) {}

  async submitInquiry(params: {
    userId?: string | null;
    input: {
      name: string;
      email: string;
      category: ContactCategory;
      subject: string;
      message: string;
      website?: string;
    };
    ipAddress?: string;
  }) {
    const cfg = await this.settingsService?.getSettings();
    if (cfg && !cfg.contactFormEnabled) {
      throw new ForbiddenError('Public contact submissions are currently disabled', 'CONTACT_DISABLED');
    }

    if (params.input.website && params.input.website.trim().length > 0) {
      throw new BadRequestError('Invalid submission', 'SPAM_REJECTED');
    }

    const ipHash = params.ipAddress
      ? sha256Hex(`${params.ipAddress}:${this.sessionSecret}`)
      : null;

    const inquiry = await this.prisma.contactInquiry.create({
      data: {
        userId: params.userId ?? null,
        name: params.input.name,
        email: params.input.email,
        category: params.input.category,
        subject: params.input.subject,
        message: params.input.message,
        ipHash,
      },
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    await this.audit.record({
      actorId: params.userId ?? null,
      action: 'CONTACT_INQUIRY_SUBMITTED',
      entityType: 'ContactInquiry',
      entityId: inquiry.id,
      metadata: {
        category: inquiry.category,
        authenticated: Boolean(params.userId),
      },
      ipAddress: params.ipAddress,
    });

    return { submitted: true, inquiry };
  }

  async listMyInquiries(userId: string) {
    const inquiries = await this.prisma.contactInquiry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        category: true,
        subject: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
      },
    });
    return { inquiries };
  }

  async listAdminInquiries(query: {
    status?: ContactStatus;
    category?: ContactCategory;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(50, Math.max(1, query.limit ?? 20));

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
    };

    const [inquiries, total] = await Promise.all([
      this.prisma.contactInquiry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, username: true } },
          reviewedBy: { select: { id: true, username: true } },
        },
      }),
      this.prisma.contactInquiry.count({ where }),
    ]);

    return {
      inquiries: inquiries.map((inq) => ({
        id: inq.id,
        name: inq.name,
        email: inq.email,
        category: inq.category,
        subject: inq.subject,
        message: inq.message,
        status: inq.status,
        adminNotes: inq.adminNotes,
        user: inq.user,
        reviewedBy: inq.reviewedBy,
        createdAt: inq.createdAt,
        resolvedAt: inq.resolvedAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async updateAdminInquiry(
    actorId: string,
    inquiryId: string,
    input: { status: ContactStatus; adminNotes?: string | null },
    ipAddress?: string,
  ) {
    const existing = await this.prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    if (!existing) throw new NotFoundError('Contact inquiry not found');

    const isResolved = input.status === 'RESOLVED' || input.status === 'CLOSED';
    const updated = await this.prisma.contactInquiry.update({
      where: { id: inquiryId },
      data: {
        status: input.status,
        ...(input.adminNotes !== undefined ? { adminNotes: input.adminNotes } : {}),
        reviewedById: actorId,
        resolvedAt: isResolved ? existing.resolvedAt ?? new Date() : null,
      },
      select: {
        id: true,
        status: true,
        adminNotes: true,
        reviewedById: true,
        resolvedAt: true,
        updatedAt: true,
      },
    });

    await this.audit.record({
      actorId,
      action: 'CONTACT_INQUIRY_UPDATED',
      entityType: 'ContactInquiry',
      entityId: inquiryId,
      metadata: { previousStatus: existing.status, newStatus: input.status },
      ipAddress,
    });

    return { inquiry: updated };
  }
}
