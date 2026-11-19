import crypto from 'node:crypto';
import type { FlagType } from '@dusklabs/shared';
import { constantTimeEqual } from './crypto.js';

export interface FlagCryptoConfig {
  encryptionKeyHex: string;
  hmacPepper: string;
}

export function computeFlagDigest(value: string, pepper: string, caseInsensitive = false): string {
  const normalized = caseInsensitive ? value.toLowerCase() : value;
  return crypto.createHmac('sha256', pepper).update(normalized, 'utf8').digest('hex');
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted flag payload');
  }
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

export function deriveDynamicFlag(params: {
  seed: string;
  pattern: string;
  challengeId: string;
  participantKey: string;
}): string {
  const token = crypto
    .createHmac('sha256', params.seed)
    .update(`${params.challengeId}:${params.participantKey}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

  if (params.pattern.includes('{{TOKEN}}')) {
    return params.pattern.replace('{{TOKEN}}', token);
  }
  return `${params.pattern}${token}`;
}

export function buildStoredFlagRecord(
  input: { flagType: FlagType; flagValue: string; dynamicPattern?: string },
  cfg: FlagCryptoConfig,
) {
  if (input.flagType === 'STATIC_EXACT') {
    return {
      flagType: input.flagType,
      flagDigest: computeFlagDigest(input.flagValue, cfg.hmacPepper, false),
      encryptedFlag: null,
      dynamicPattern: null,
    };
  }

  if (input.flagType === 'STATIC_CASE_INSENSITIVE') {
    return {
      flagType: input.flagType,
      flagDigest: computeFlagDigest(input.flagValue, cfg.hmacPepper, true),
      encryptedFlag: null,
      dynamicPattern: null,
    };
  }

  const pattern = input.dynamicPattern?.trim() || 'DUSK{{{TOKEN}}}';
  const seed = `${input.flagValue}:${crypto.randomBytes(16).toString('hex')}`;
  return {
    flagType: input.flagType,
    flagDigest: null,
    encryptedFlag: encryptSecret(seed, cfg.encryptionKeyHex),
    dynamicPattern: pattern,
  };
}

export function verifyCandidateFlag(params: {
  stored: {
    flagType: string;
    flagDigest: string | null;
    encryptedFlag: string | null;
    dynamicPattern: string | null;
  };
  candidateFlag: string;
  challengeId: string;
  participantKey?: string;
  cfg: FlagCryptoConfig;
}): boolean {
  const candidate = params.candidateFlag.trim();

  if (params.stored.flagType === 'STATIC_EXACT') {
    if (!params.stored.flagDigest) return false;
    const digest = computeFlagDigest(candidate, params.cfg.hmacPepper, false);
    return constantTimeEqual(digest, params.stored.flagDigest);
  }

  if (params.stored.flagType === 'STATIC_CASE_INSENSITIVE') {
    if (!params.stored.flagDigest) return false;
    const digest = computeFlagDigest(candidate, params.cfg.hmacPepper, true);
    return constantTimeEqual(digest, params.stored.flagDigest);
  }

  if (params.stored.flagType === 'DYNAMIC_HMAC_PATTERN') {
    if (!params.stored.encryptedFlag || !params.stored.dynamicPattern || !params.participantKey) {
      return false;
    }
    const seed = decryptSecret(params.stored.encryptedFlag, params.cfg.encryptionKeyHex);
    const expected = deriveDynamicFlag({
      seed,
      pattern: params.stored.dynamicPattern,
      challengeId: params.challengeId,
      participantKey: params.participantKey,
    });
    return constantTimeEqual(candidate, expected);
  }

  return false;
}
