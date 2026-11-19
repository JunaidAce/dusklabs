import { z } from 'zod';

const rustInspectionResponseSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().nonnegative(),
  detected_mime: z.string().min(1),
  is_archive: z.boolean(),
  archive_summary: z
    .object({
      entry_count: z.number().int().nonnegative(),
      total_uncompressed_bytes: z.number().int().nonnegative(),
      max_compression_ratio: z.number().nonnegative(),
      entries: z.array(
        z.object({
          name: z.string(),
          compressed_bytes: z.number().int().nonnegative(),
          uncompressed_bytes: z.number().int().nonnegative(),
          is_dir: z.boolean(),
        }),
      ),
    })
    .nullable(),
  safety_checks: z.object({
    passed: z.boolean(),
    violations: z.array(z.string()),
  }),
});

export type RustAttachmentInspection = z.infer<typeof rustInspectionResponseSchema>;

export class RustServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RustServiceUnavailableError';
  }
}

export function assertTrustedInternalUrl(urlString: string): void {
  const parsed = new URL(urlString);
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.internal');
  if (!isLoopback) {
    throw new Error(`Untrusted RUST_ATTACHMENT_URL host: ${host}`);
  }
}

export async function inspectAttachmentWithRust(params: {
  baseUrl: string;
  internalToken: string;
  storageKey: string;
  originalName: string;
  maxFileBytes: number;
  timeoutMs: number;
}): Promise<RustAttachmentInspection> {
  assertTrustedInternalUrl(params.baseUrl);

  let res: Response;
  try {
    res = await fetch(`${params.baseUrl.replace(/\/$/, '')}/internal/v1/attachments/inspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': params.internalToken,
      },
      body: JSON.stringify({
        relative_key: params.storageKey,
        original_name: params.originalName,
        max_file_bytes: params.maxFileBytes,
      }),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
  } catch (err) {
    throw new RustServiceUnavailableError(
      err instanceof Error ? err.message : 'Rust attachment-processor unreachable',
    );
  }

  if (res.status >= 500) {
    throw new RustServiceUnavailableError(`Rust service error (${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`Rust attachment-processor rejected request (${res.status})`);
  }

  const rawJson = await res.json();
  const parsed = rustInspectionResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error('Malformed inspection response from Rust attachment-processor');
  }

  return parsed.data;
}
