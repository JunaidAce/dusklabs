import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { RoleName } from '@dusklabs/shared';
import type { PrismaClient } from '@prisma/client';
import {
  inspectAttachmentWithRust,
  RustServiceUnavailableError,
} from '../../integrations/rustAttachmentClient.js';
import type { AuthenticatedContext } from '../../middleware/auth.js';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '../../utils/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { inspectAttachmentFallbackTs } from './attachmentFallback.js';

export interface AttachmentConfig {
  uploadDir: string;
  maxFileBytes: number;
  rustUrl: string;
  rustInternalToken: string;
  rustTimeoutMs: number;
  allowTsFallback: boolean;
}

function sanitizeDisplayFilename(raw: string): string {
  const base = path
    .basename(raw)
    .replace(/[\x00-\x1f\x7f\r\n"\\/;]/g, '_')
    .trim();
  return base.slice(0, 120) || 'artifact.bin';
}

export class AttachmentsService {
  private readonly vaultRoot: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly config: AttachmentConfig,
    private readonly logWarn: (msg: string, meta?: Record<string, unknown>) => void,
  ) {
    this.vaultRoot = path.resolve(config.uploadDir);
    fs.mkdirSync(this.vaultRoot, { recursive: true });
  }

  private resolveVaultPath(storageKey: string): string {
    if (!storageKey || storageKey.includes('..') || storageKey.includes('/') || storageKey.includes('\\')) {
      throw new BadRequestError('Invalid attachment storage key');
    }
    const target = path.resolve(this.vaultRoot, storageKey);
    if (!target.startsWith(this.vaultRoot + path.sep)) {
      throw new BadRequestError('Resolved path escapes attachment vault');
    }
    return target;
  }

  private isPlatformAdmin(auth: AuthenticatedContext): boolean {
    return (
      auth.roles.includes('SUPER_ADMIN' satisfies RoleName) ||
      auth.roles.includes('PLATFORM_ADMIN' satisfies RoleName)
    );
  }

  private async assertCanManageChallenge(
    auth: AuthenticatedContext,
    challengeId: string,
  ) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { id: challengeId },
      select: { id: true, authorId: true, createdById: true, competitionId: true },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');

    if (this.isPlatformAdmin(auth)) return challenge;
    if (auth.roles.includes('COMPETITION_ORGANIZER') && challenge.competitionId) {
      const comp = await this.prisma.competition.findUnique({
        where: { id: challenge.competitionId },
        select: { createdById: true },
      });
      if (comp?.createdById === auth.userId) return challenge;
    }
    if (
      auth.roles.includes('CHALLENGE_AUTHOR') &&
      (challenge.authorId === auth.userId || challenge.createdById === auth.userId)
    ) {
      return challenge;
    }
    throw new ForbiddenError('You are not authorized to manage attachments for this challenge');
  }

  private async assertCanDownloadChallenge(
    auth: AuthenticatedContext,
    challenge: {
      id: string;
      status: string;
      isVisible: boolean;
      authorId: string | null;
      createdById: string | null;
      competitionId: string | null;
    },
  ): Promise<void> {
    // Staff authorized to manage this challenge can download during DRAFT/TESTING
    try {
      await this.assertCanManageChallenge(auth, challenge.id);
      return;
    } catch {
      // Fall through to participant eligibility check
    }

    if (challenge.status !== 'PUBLISHED' || !challenge.isVisible) {
      throw new NotFoundError('Attachment not found');
    }

    if (!challenge.competitionId) return;

    const comp = await this.prisma.competition.findUnique({
      where: { id: challenge.competitionId },
      select: { id: true, status: true },
    });
    if (!comp) throw new NotFoundError('Attachment not found');
    if (comp.status === 'COMPLETED') return;
    if (comp.status !== 'LIVE') {
      throw new ForbiddenError('Competition is not currently live');
    }

    const reg = await this.prisma.competitionRegistration.findUnique({
      where: { competitionId_userId: { competitionId: comp.id, userId: auth.userId } },
    });
    if (reg?.status === 'CONFIRMED') return;

    const teamMember = await this.prisma.teamMember.findFirst({
      where: {
        userId: auth.userId,
        team: {
          deletedAt: null,
          competitions: { some: { competitionId: comp.id, status: 'CONFIRMED' } },
        },
      },
    });
    if (!teamMember) {
      throw new ForbiddenError('Registration in the competition is required to download this artifact');
    }
  }

  private async writeAndInspectStream(
    fileStream: NodeJS.ReadableStream,
    rawFilename: string,
  ) {
    const safeName = sanitizeDisplayFilename(rawFilename);
    const storageKey = `${crypto.randomUUID()}.dat`;
    const destPath = this.resolveVaultPath(storageKey);

    try {
      await pipeline(fileStream, fs.createWriteStream(destPath, { flags: 'wx' }));

      const stat = await fs.promises.stat(destPath);
      if (stat.size > this.config.maxFileBytes) {
        throw new BadRequestError(
          `File exceeds maximum allowed size (${this.config.maxFileBytes} bytes)`,
          'FILE_TOO_LARGE',
        );
      }

      let engine: 'RUST' | 'TS_FALLBACK' = 'RUST';
      let report;

      try {
        report = await inspectAttachmentWithRust({
          baseUrl: this.config.rustUrl,
          internalToken: this.config.rustInternalToken,
          storageKey,
          originalName: safeName,
          maxFileBytes: this.config.maxFileBytes,
          timeoutMs: this.config.rustTimeoutMs,
        });
      } catch (err) {
        if (err instanceof RustServiceUnavailableError && this.config.allowTsFallback) {
          this.logWarn('Rust attachment-processor unavailable; running equivalent TS fallback');
          engine = 'TS_FALLBACK';
          report = await inspectAttachmentFallbackTs({
            filePath: destPath,
            originalName: safeName,
            maxFileBytes: this.config.maxFileBytes,
          });
        } else if (err instanceof RustServiceUnavailableError) {
          const unavailable: any = new Error('Attachment inspection service unavailable');
          unavailable.statusCode = 503;
          unavailable.code = 'ATTACHMENT_PROCESSOR_UNAVAILABLE';
          throw unavailable;
        } else {
          throw new BadRequestError(
            err instanceof Error ? err.message : 'Attachment inspection failed',
            'ATTACHMENT_REJECTED',
          );
        }
      }

      if (!report.safety_checks.passed) {
        throw new BadRequestError(
          `Attachment failed security inspection: ${report.safety_checks.violations.join('; ')}`,
          'ATTACHMENT_UNSAFE',
        );
      }

      return {
        storageKey,
        safeName,
        engine,
        report,
      };
    } catch (err) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw err;
    }
  }

  async uploadAttachment(
    auth: AuthenticatedContext,
    challengeId: string,
    fileStream: NodeJS.ReadableStream,
    rawFilename: string,
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const inspected = await this.writeAndInspectStream(fileStream, rawFilename);

    try {
      const attachment = await this.prisma.challengeAttachment.create({
        data: {
          challengeId,
          uploadedById: auth.userId,
          originalName: inspected.safeName,
          storageKey: inspected.storageKey,
          mimeType: inspected.report.detected_mime,
          sizeBytes: inspected.report.size_bytes,
          sha256: inspected.report.sha256,
          archiveEntryCount: inspected.report.archive_summary?.entry_count ?? null,
          inspectionEngine: inspected.engine,
        },
        select: {
          id: true,
          challengeId: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          archiveEntryCount: true,
          inspectionEngine: true,
          downloadCount: true,
          createdAt: true,
        },
      });

      await this.audit.record({
        actorId: auth.userId,
        action: 'CHALLENGE_ATTACHMENT_UPLOADED',
        entityType: 'ChallengeAttachment',
        entityId: attachment.id,
        metadata: {
          challengeId,
          sha256: attachment.sha256,
          sizeBytes: attachment.sizeBytes,
          engine: inspected.engine,
        },
        ipAddress,
      });

      return { attachment };
    } catch (err) {
      await fs.promises.unlink(this.resolveVaultPath(inspected.storageKey)).catch(() => {});
      throw err;
    }
  }

  async replaceAttachment(
    auth: AuthenticatedContext,
    challengeId: string,
    attachmentId: string,
    fileStream: NodeJS.ReadableStream,
    rawFilename: string,
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const existing = await this.prisma.challengeAttachment.findFirst({
      where: { id: attachmentId, challengeId },
    });
    if (!existing) throw new NotFoundError('Attachment not found');

    const inspected = await this.writeAndInspectStream(fileStream, rawFilename);

    try {
      const updated = await this.prisma.challengeAttachment.update({
        where: { id: existing.id },
        data: {
          uploadedById: auth.userId,
          originalName: inspected.safeName,
          storageKey: inspected.storageKey,
          mimeType: inspected.report.detected_mime,
          sizeBytes: inspected.report.size_bytes,
          sha256: inspected.report.sha256,
          archiveEntryCount: inspected.report.archive_summary?.entry_count ?? null,
          inspectionEngine: inspected.engine,
        },
        select: {
          id: true,
          challengeId: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          archiveEntryCount: true,
          inspectionEngine: true,
          updatedAt: true,
        },
      });

      // Remove old artifact only after DB update succeeds
      await fs.promises.unlink(this.resolveVaultPath(existing.storageKey)).catch(() => {});

      await this.audit.record({
        actorId: auth.userId,
        action: 'CHALLENGE_ATTACHMENT_REPLACED',
        entityType: 'ChallengeAttachment',
        entityId: updated.id,
        metadata: { challengeId, sha256: updated.sha256, engine: inspected.engine },
        ipAddress,
      });

      return { attachment: updated };
    } catch (err) {
      await fs.promises.unlink(this.resolveVaultPath(inspected.storageKey)).catch(() => {});
      throw err;
    }
  }

  async deleteAttachment(
    auth: AuthenticatedContext,
    challengeId: string,
    attachmentId: string,
    ipAddress?: string,
  ) {
    await this.assertCanManageChallenge(auth, challengeId);
    const existing = await this.prisma.challengeAttachment.findFirst({
      where: { id: attachmentId, challengeId },
    });
    if (!existing) throw new NotFoundError('Attachment not found');

    await this.prisma.challengeAttachment.delete({ where: { id: existing.id } });
    await fs.promises.unlink(this.resolveVaultPath(existing.storageKey)).catch(() => {});

    await this.audit.record({
      actorId: auth.userId,
      action: 'CHALLENGE_ATTACHMENT_DELETED',
      entityType: 'ChallengeAttachment',
      entityId: attachmentId,
      metadata: { challengeId },
      ipAddress,
    });

    return { deleted: true };
  }

  async listChallengeAttachments(auth: AuthenticatedContext, slug: string) {
    const challenge = await this.prisma.challenge.findUnique({
      where: { slug },
      select: {
        id: true,
        status: true,
        isVisible: true,
        authorId: true,
        createdById: true,
        competitionId: true,
      },
    });
    if (!challenge) throw new NotFoundError('Challenge not found');
    await this.assertCanDownloadChallenge(auth, challenge);

    const attachments = await this.prisma.challengeAttachment.findMany({
      where: { challengeId: challenge.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        archiveEntryCount: true,
        downloadCount: true,
        createdAt: true,
      },
    });

    return { attachments };
  }

  async prepareAuthorizedDownload(auth: AuthenticatedContext, attachmentId: string) {
    const att = await this.prisma.challengeAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        challenge: {
          select: {
            id: true,
            status: true,
            isVisible: true,
            authorId: true,
            createdById: true,
            competitionId: true,
          },
        },
      },
    });
    if (!att) throw new NotFoundError('Attachment not found');

    await this.assertCanDownloadChallenge(auth, att.challenge);

    const fullPath = this.resolveVaultPath(att.storageKey);
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundError('Attachment file is missing from vault');
    }

    await this.prisma.challengeAttachment.update({
      where: { id: att.id },
      data: { downloadCount: { increment: 1 } },
    });

    return {
      originalName: att.originalName,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
      stream: fs.createReadStream(fullPath),
    };
  }
}
