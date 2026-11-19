import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const raw = Array.isArray(sc) ? String(sc[0]) : String(sc ?? '');
  return raw.split(';')[0] ?? '';
}

function buildMultipart(filename: string, content: Buffer, contentType = 'application/octet-stream') {
  const boundary = '----DuskLabsBoundary778899';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([head, content, tail]),
  };
}

// Builds a minimal valid Stored/Deflated ZIP archive in memory for testing
function createZipBuffer(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const comp = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = 0; // Sufficient for structural EOCD/CD inspection tests

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    locals.push(local, comp);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centrals.push(central);
    offset += local.length + comp.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe('Phase 3 Step 3.3 — Rust Attachment Integration & Fallback Security', () => {
  const prisma = new PrismaClient();
  const suffix = Date.now().toString(36);
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'dusklabs-vault-'));

  let mockMode: 'OK' | 'MALFORMED_RESPONSE' | 'SERVER_ERROR' = 'OK';
  let mockServer: http.Server;
  let mockPort = 0;

  const cleanupUsers: string[] = [];
  const cleanupChallenges: string[] = [];
  const cleanupComps: string[] = [];

  async function createUser(ctx: Awaited<ReturnType<typeof buildApp>>, tag: string, roleName?: string) {
    const username = `att_${tag}_${suffix}`;
    const email = `${username}@dusklabs.local`;
    const password = 'AttachStrongPassword!123';
    const reg = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username, displayName: `User ${tag}`, email, password },
    });
    const userId = reg.json().user.id as string;
    cleanupUsers.push(userId);
    if (roleName) {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
      await prisma.userRole.create({ data: { userId, roleId: role.id } });
    }
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: username, password },
    });
    return {
      userId,
      cookie: cookieOf(login),
      csrf: login.json().csrfToken as string,
    };
  }

  beforeAll(async () => {
    await prisma.$connect();

    // Local loopback stub simulating Rust attachment-processor responses & failures
    mockServer = http.createServer(async (req, res) => {
      if (req.headers['x-internal-service-token'] !== 'test-rust-internal-token') {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        relative_key: string;
        original_name: string;
      };

      if (mockMode === 'SERVER_ERROR') {
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      if (mockMode === 'MALFORMED_RESPONSE') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ unexpected: true }));
        return;
      }

      const fileBytes = fs.readFileSync(path.join(tempVault, body.relative_key));
      const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          sha256,
          size_bytes: fileBytes.length,
          detected_mime: body.original_name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
          is_archive: body.original_name.endsWith('.zip'),
          archive_summary: body.original_name.endsWith('.zip')
            ? { entry_count: 1, total_uncompressed_bytes: 12, max_compression_ratio: 1.0, entries: [] }
            : null,
          safety_checks: { passed: true, violations: [] },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as { port: number }).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (cleanupChallenges.length) {
      await prisma.challenge.deleteMany({ where: { id: { in: cleanupChallenges } } });
    }
    if (cleanupComps.length) {
      await prisma.competition.deleteMany({ where: { id: { in: cleanupComps } } });
    }
    if (cleanupUsers.length) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
    }
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    fs.rmSync(tempVault, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('uploads via Rust service, enforces authZ, replaces, downloads, and deletes cleanly', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0004',
      FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00004',
      DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
      UPLOAD_DIR: tempVault,
      MAX_ATTACHMENT_BYTES: '1048576',
      RUST_ATTACHMENT_URL: `http://127.0.0.1:${mockPort}`,
      RUST_INTERNAL_TOKEN: 'test-rust-internal-token',
      ALLOW_TS_ATTACHMENT_FALLBACK: 'false',
    });

    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const author = await createUser(ctx, 'auth', 'CHALLENGE_AUTHOR');
      const outsider = await createUser(ctx, 'out');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const chalRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: {
          slug: `att-chal-${suffix}`,
          title: 'Artifact Challenge',
          description: 'Download and inspect artifact.',
          difficulty: 'EASY',
          points: 100,
          initialPoints: 100,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{att_test}' },
        },
      });
      const chalId = chalRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // Unauthorized participant upload blocked (403)
      const mp1 = buildMultipart('notes.txt', Buffer.from('hello world'));
      const unauthUp = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: {
          cookie: outsider.cookie,
          'x-csrf-token': outsider.csrf,
          'content-type': mp1.contentType,
        },
        payload: mp1.payload,
      });
      expect(unauthUp.statusCode).toBe(403);

      // Valid upload via Rust
      mockMode = 'OK';
      const validUp = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: {
          cookie: author.cookie,
          'x-csrf-token': author.csrf,
          'content-type': mp1.contentType,
        },
        payload: mp1.payload,
      });
      expect(validUp.statusCode).toBe(201);
      const attId = validUp.json().attachment.id as string;
      expect(validUp.json().attachment.storageKey).toBeUndefined();
      expect(validUp.json().attachment.inspectionEngine).toBe('RUST');

      // Unpublished challenge download blocked for outsider (404)
      const unauthDl = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${attId}/download`,
        headers: { cookie: outsider.cookie },
      });
      expect(unauthDl.statusCode).toBe(404);

      // Publish challenge -> outsider can download with attachment headers
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/transition`,
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
        payload: { targetStatus: 'PUBLISHED' },
      });

      const okDl = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${attId}/download`,
        headers: { cookie: outsider.cookie },
      });
      expect(okDl.statusCode).toBe(200);
      expect(okDl.headers['content-disposition']).toContain('attachment; filename="notes.txt"');
      expect(okDl.headers['x-content-type-options']).toBe('nosniff');
      expect(okDl.body).toBe('hello world');

      // Replace attachment
      const mp2 = buildMultipart('updated.txt', Buffer.from('v2 artifact'));
      const repRes = await ctx.app.inject({
        method: 'PUT',
        url: `/api/v1/challenges/${chalId}/attachments/${attId}`,
        headers: {
          cookie: author.cookie,
          'x-csrf-token': author.csrf,
          'content-type': mp2.contentType,
        },
        payload: mp2.payload,
      });
      expect(repRes.statusCode).toBe(200);
      expect(repRes.json().attachment.originalName).toBe('updated.txt');

      // Rust malformed response rejected safely
      mockMode = 'MALFORMED_RESPONSE';
      const badResp = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: {
          cookie: author.cookie,
          'x-csrf-token': author.csrf,
          'content-type': mp2.contentType,
        },
        payload: mp2.payload,
      });
      expect(badResp.statusCode).toBe(400);

      // Rust unavailable with fallback disabled -> 503 (never bypasses)
      mockMode = 'SERVER_ERROR';
      const strictUnavailable = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: {
          cookie: author.cookie,
          'x-csrf-token': author.csrf,
          'content-type': mp2.contentType,
        },
        payload: mp2.payload,
      });
      expect(strictUnavailable.statusCode).toBe(503);

      // Delete attachment cleans DB and file
      const delRes = await ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/challenges/${chalId}/attachments/${attId}`,
        headers: { cookie: author.cookie, 'x-csrf-token': author.csrf },
      });
      expect(delRes.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
    }
  });

  it('rejects oversized files, invalid MIME, ZIP traversal, ZIP bombs, and malformed archives via TS fallback when Rust is down', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-with-more-than-32-chars-0005',
      FLAG_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      FLAG_HMAC_PEPPER: 'test-flag-pepper-with-more-than-32-chars-00005',
      DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',
      UPLOAD_DIR: tempVault,
      MAX_ATTACHMENT_BYTES: '65536', // 64 KiB cap
      RUST_ATTACHMENT_URL: 'http://127.0.0.1:1', // Unreachable loopback port
      RUST_INTERNAL_TOKEN: 'test-rust-internal-token',
      ALLOW_TS_ATTACHMENT_FALLBACK: 'true',
    });

    const ctx = await buildApp({ env, prisma, authRateLimitMax: 100 });
    try {
      const admin = await createUser(ctx, 'fb_adm', 'PLATFORM_ADMIN');
      const webCat = await prisma.category.findUniqueOrThrow({ where: { slug: 'web-exploitation' } });

      const chalRes = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/challenges',
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
        payload: {
          slug: `fb-chal-${suffix}`,
          title: 'Fallback Inspection Test',
          description: 'Testing equivalent TS fallback controls.',
          difficulty: 'EASY',
          points: 100,
          initialPoints: 100,
          categoryIds: [webCat.id],
          flagConfig: { flagType: 'STATIC_EXACT', flagValue: 'DUSK{fb}' },
        },
      });
      const chalId = chalRes.json().challenge.id as string;
      cleanupChallenges.push(chalId);

      // 1. Oversized file rejected (413)
      const big = buildMultipart('big.bin', Buffer.alloc(100_000, 0x41));
      const bigRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': big.contentType },
        payload: big.payload,
      });
      expect(bigRes.statusCode).toBe(413);

      // 2. Spoofed MIME / PE executable disguised as .png rejected (400)
      const spoofed = buildMultipart('evil.png', Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00'));
      const spoofRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': spoofed.contentType },
        payload: spoofed.payload,
      });
      expect(spoofRes.statusCode).toBe(400);

      // 3. ZIP path traversal rejected (400)
      const travZip = createZipBuffer([{ name: '../../etc/passwd', data: Buffer.from('root:x:0:0') }]);
      const travMp = buildMultipart('trav.zip', travZip, 'application/zip');
      const travRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': travMp.contentType },
        payload: travMp.payload,
      });
      expect(travRes.statusCode).toBe(400);

      // 4. ZIP bomb rejected (400)
      const bombZip = createZipBuffer([{ name: 'zeros.bin', data: Buffer.alloc(512 * 1024, 0), deflate: true }]);
      const bombMp = buildMultipart('bomb.zip', bombZip, 'application/zip');
      const bombRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': bombMp.contentType },
        payload: bombMp.payload,
      });
      expect(bombRes.statusCode).toBe(400);

      // 5. Malformed ZIP rejected (400)
      const badZip = buildMultipart('broken.zip', Buffer.from('PK\x03\x04not_valid'), 'application/zip');
      const badZipRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': badZip.contentType },
        payload: badZip.payload,
      });
      expect(badZipRes.statusCode).toBe(400);

      // 6. Valid ZIP succeeds via TS_FALLBACK
      const okZip = createZipBuffer([{ name: 'src/chal.py', data: Buffer.from('print("ok")') }]);
      const okMp = buildMultipart('chal.zip', okZip, 'application/zip');
      const okRes = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/challenges/${chalId}/attachments`,
        headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': okMp.contentType },
        payload: okMp.payload,
      });
      expect(okRes.statusCode).toBe(201);
      expect(okRes.json().attachment.inspectionEngine).toBe('TS_FALLBACK');
      expect(okRes.json().attachment.archiveEntryCount).toBe(1);
    } finally {
      await ctx.app.close();
    }
  });
});
