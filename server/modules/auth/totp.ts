/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), the second
 * factor a login asks for once the user has turned it on.
 *
 * Built on `node:crypto` alone: SHA-1, 30-second steps, 6 digits — the values
 * every authenticator app uses by default. Pure functions: the clock is a
 * parameter, so a test pins it instead of waiting for it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now, for a phone clock that is a little off. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) {
      throw new Error('TOTP secret is not base32');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new 160-bit secret, base32 as authenticator apps expect it. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secret: string, nowMs: number): string {
  return hotp(secret, totpCounter(nowMs));
}

/**
 * The step counter `code` matches within the window around `nowMs`, or null.
 * The counter is returned so the caller can refuse a code that was already
 * used (a replay inside its 90-second life).
 */
export function matchTotp(secret: string, code: string, nowMs: number): number | null {
  const candidate = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) {
    return null;
  }
  const now = totpCounter(nowMs);
  const given = Buffer.from(candidate);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const counter = now + offset;
    if (counter < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, counter)), given)) {
      return counter;
    }
  }
  return null;
}

/** The `otpauth://` URI an authenticator app imports (as text or a QR code). */
export function totpUri(secret: string, username: string, issuer = 'CloudCLI'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
