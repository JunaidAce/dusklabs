import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { RustAttachmentInspection } from '../../integrations/rustAttachmentClient.js';

const ALLOWED_EXTENSIONS = new Set([
  'zip', 'txt', 'py', 'c', 'cpp', 'h', 'rs', 'go', 'json', 'csv', 'md',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'pcap', 'pcapng', 'bin', 'elf',
  'tar', 'gz', 'xz', '7z',
  'wav', 'mp3', 'ogg', 'flac', 'm4a', 'mp4', 'webm',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'py', 'c', 'cpp', 'h', 'rs', 'go', 'json', 'csv', 'md']);
const FORBIDDEN_MIMES = new Set([
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload',
  'application/x-dosexec',
]);

const EXPECTED_MAGIC: Record<string, string[]> = {
  zip: ['application/zip'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  pdf: ['application/pdf'],
  gz: ['application/gzip'],
  '7z': ['application/x-7z-compressed'],
  xz: ['application/x-xz'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'audio/wave'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  ogg: ['audio/ogg', 'application/ogg', 'video/ogg'],
  flac: ['audio/flac', 'audio/x-flac'],
  m4a: ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  mp4: ['video/mp4'],
  webm: ['video/webm', 'audio/webm'],
};

function isUnsafeArchivePath(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes('\0') || name.includes('\\')) {
    return true;
  }
  if (name.length >= 2 && name[1] === ':') return true;
  return name.split('/').some((seg) => seg === '..');
}

// Inspects ZIP Central Directory without decompressing any bytes (prevents zip-bomb memory exhaustion)
function inspectZipBufferSafely(
  buf: Buffer,
  limits: { maxEntries: number; maxUncompressed: number; maxRatio: number },
  violations: string[],
) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    violations.push('Malformed ZIP archive: missing EOCD record');
    return null;
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (totalEntries > limits.maxEntries) {
    violations.push(`Archive entry count ${totalEntries} exceeds limit ${limits.maxEntries}`);
  }
  if (cdOffset >= eocdOffset) {
    violations.push('Malformed ZIP archive: invalid central directory offset');
    return null;
  }

  let cursor = cdOffset;
  let totalUncompressed = 0;
  let maxRatio = 0;
  const entries: Array<{
    name: string;
    compressed_bytes: number;
    uncompressed_bytes: number;
    is_dir: boolean;
  }> = [];

  for (let i = 0; i < Math.min(totalEntries, limits.maxEntries); i++) {
    if (cursor + 46 > eocdOffset || buf.readUInt32LE(cursor) !== 0x02014b50) {
      violations.push(`Malformed ZIP entry at index ${i}`);
      break;
    }
    const compressed = buf.readUInt32LE(cursor + 20);
    const uncompressed = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);

    if (cursor + 46 + nameLen > eocdOffset) {
      violations.push(`Malformed ZIP entry filename at index ${i}`);
      break;
    }

    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (isUnsafeArchivePath(name)) {
      violations.push(`Unsafe archive entry path detected: ${name}`);
    }

    totalUncompressed += uncompressed;
    const ratio = compressed > 0 ? uncompressed / compressed : uncompressed > 0 ? Infinity : 1;
    if (ratio > maxRatio) maxRatio = ratio;
    if (ratio > limits.maxRatio) {
      violations.push(`Archive bomb suspected on '${name}': compression ratio exceeds ${limits.maxRatio}x`);
    }

    entries.push({
      name,
      compressed_bytes: compressed,
      uncompressed_bytes: uncompressed,
      is_dir: name.endsWith('/'),
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  if (totalUncompressed > limits.maxUncompressed) {
    violations.push(`Total uncompressed size ${totalUncompressed} exceeds limit ${limits.maxUncompressed}`);
  }

  return {
    entry_count: totalEntries,
    total_uncompressed_bytes: totalUncompressed,
    max_compression_ratio: Number.isFinite(maxRatio) ? maxRatio : 999999,
    entries,
  };
}

export async function inspectAttachmentFallbackTs(params: {
  filePath: string;
  originalName: string;
  maxFileBytes: number;
}): Promise<RustAttachmentInspection> {
  const stat = await fs.promises.stat(params.filePath);
  const violations: string[] = [];

  if (stat.size === 0) violations.push('Empty file uploads are not permitted');
  if (stat.size > params.maxFileBytes) {
    violations.push(`File size ${stat.size} exceeds limit ${params.maxFileBytes}`);
  }

  const ext = path.extname(params.originalName).replace('.', '').toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    violations.push(`Disallowed file extension '.${ext || 'none'}'`);
  }

  const buf = await fs.promises.readFile(params.filePath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const detected = await fileTypeFromBuffer(buf.subarray(0, 8192));
  const detectedMime = detected?.mime ?? 'application/octet-stream';

  if (FORBIDDEN_MIMES.has(detectedMime)) {
    violations.push(`Forbidden executable MIME type detected: ${detectedMime}`);
  }

  const expected = EXPECTED_MAGIC[ext];
  if (expected && !expected.includes(detectedMime)) {
    violations.push(`MIME mismatch for '.${ext}': detected '${detectedMime}'`);
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    if (detectedMime !== 'application/octet-stream' && !detectedMime.startsWith('text/')) {
      violations.push(`Binary payload ('${detectedMime}') disguised as '.${ext}'`);
    } else {
      const prefix = buf.subarray(0, 512).toString('utf8').toLowerCase();
      if (prefix.includes('<html') || prefix.includes('<!doctype html') || prefix.includes('<svg')) {
        violations.push('Disallowed HTML/SVG markup inside text attachment');
      }
    }
  }

  const isZip = detectedMime === 'application/zip' || ext === 'zip';
  let archiveSummary = null;
  if (isZip && violations.length === 0) {
    archiveSummary = inspectZipBufferSafely(
      buf,
      { maxEntries: 512, maxUncompressed: 100 * 1024 * 1024, maxRatio: 100 },
      violations,
    );
  }

  return {
    sha256,
    size_bytes: stat.size,
    detected_mime: detectedMime,
    is_archive: isZip,
    archive_summary: archiveSummary,
    safety_checks: { passed: violations.length === 0, violations },
  };
}
