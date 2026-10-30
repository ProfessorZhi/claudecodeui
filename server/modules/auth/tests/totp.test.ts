import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';
import { createCredentialVerifier } from '../credential-verifier.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  totp,
  totpUri,
} from '../totp.js';

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('RFC 6238 SHA-1 vectors (last six digits)', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(totp(RFC_SECRET, seconds * 1000), code, `t=${seconds}`);
  }
});

test('RFC 4226 HOTP vectors', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314'];
  expected.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter), code));
});

test('base32 round-trips and a generated secret is 160 bits', () => {
  const bytes = Buffer.from('any bytes at all');
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.equal(base32Decode(generateTotpSecret()).length, 20);
  assert.throws(() => base32Decode('not*base32'));
});

test('a code matches within one step either side and not beyond', () => {
  const now = 1_700_000_000_000;
  const secret = generateTotpSecret();
  assert.notEqual(matchTotp(secret, totp(secret, now - 30_000), now), null);
  assert.notEqual(matchTotp(secret, totp(secret, now + 30_000), now), null);
  assert.equal(matchTotp(secret, totp(secret, now - 120_000), now), null);
  assert.equal(matchTotp(secret, 'abcdef', now), null);
  assert.equal(matchTotp(secret, '12345', now), null);
});

test('the otpauth URI carries the secret and the issuer', () => {
  const uri = totpUri('ABC', 'alice');
  assert.match(uri, /^otpauth:\/\/totp\/CloudCLI%3Aalice\?/);
  assert.match(uri, /secret=ABC/);
  assert.match(uri, /issuer=CloudCLI/);
});

// -- the service --------------------------------------------------------------

type Row = {
  id: number;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_enabled: number;
  totp_last_counter: number | null;
};

function harness(nowMs: number) {
  const row: Row = {
    id: 7, username: 'alice', password_hash: 'hash', totp_secret: null,
    totp_pending_secret: null, totp_enabled: 0, totp_last_counter: null,
  };
  const clock = { now: nowMs };
  const service = createAuthService({
    users: {
      hasUsers: () => true,
      createUser: () => ({ id: 7, username: 'alice' }),
      getUserByUsername: (username) => (username === 'alice' ? { ...row } : undefined),
      updateLastLogin: () => undefined,
      setPendingTotpSecret: (_id, secret) => { row.totp_pending_secret = secret; },
      enableTotp: (_id, counter) => {
        if (!row.totp_pending_secret) return false;
        row.totp_secret = row.totp_pending_secret;
        row.totp_pending_secret = null;
        row.totp_enabled = 1;
        row.totp_last_counter = counter;
        return true;
      },
      disableTotp: () => {
        Object.assign(row, { totp_secret: null, totp_pending_secret: null, totp_enabled: 0, totp_last_counter: null });
      },
      consumeTotpCounter: (_id, counter) => {
        if (row.totp_last_counter !== null && row.totp_last_counter >= counter) return false;
        row.totp_last_counter = counter;
        return true;
      },
    },
    transaction: { begin: () => undefined, commit: () => undefined, rollback: () => undefined },
    hashPassword: async () => 'hash',
    comparePassword: async (password) => password === 'right-password',
    generateToken: () => 'signed-token',
    now: () => clock.now,
  });
  return { service, row, clock };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

const SESSION = { id: 7, username: 'alice' };
const T0 = 1_700_000_000_000;

test('without 2FA, login is username + password as before', async () => {
  const { service } = harness(T0);
  const result = await service.login('alice', 'right-password');
  assert.equal(result.token, 'signed-token');
});

test('setup alone changes nothing; enable needs a code from the new secret', async () => {
  const { service } = harness(T0);
  const { secret, otpauthUri } = service.totpSetup(SESSION);
  assert.match(otpauthUri, /^otpauth:\/\//);
  assert.deepEqual(service.totpStatus(SESSION), { enabled: false, pending: true });
  assert.equal((await service.login('alice', 'right-password')).token, 'signed-token');

  assert.throws(() => service.totpEnable(SESSION, '000000'), (e: unknown) => e instanceof AppError && e.code === 'AUTH_INVALID_TOTP');
  assert.deepEqual(service.totpEnable(SESSION, totp(secret, T0)), { enabled: true });
  assert.deepEqual(service.totpStatus(SESSION), { enabled: true, pending: false });
});

test('with 2FA on, login asks for a code, refuses a wrong one, and refuses a replay', async () => {
  const { service, clock } = harness(T0);
  const { secret } = service.totpSetup(SESSION);
  service.totpEnable(SESSION, totp(secret, T0));

  clock.now = T0 + 60_000;
  await rejectsWith(service.login('alice', 'right-password'), 'AUTH_TOTP_REQUIRED');
  await rejectsWith(service.login('alice', 'right-password', '000000'), 'AUTH_INVALID_TOTP');
  await rejectsWith(service.login('alice', 'wrong', totp(secret, clock.now)), 'AUTH_INVALID_CREDENTIALS');

  const code = totp(secret, clock.now);
  assert.equal((await service.login('alice', 'right-password', code)).token, 'signed-token');
  await rejectsWith(service.login('alice', 'right-password', code), 'AUTH_INVALID_TOTP');
});

test('the code used to enable cannot be replayed to log in', async () => {
  const { service } = harness(T0);
  const { secret } = service.totpSetup(SESSION);
  const code = totp(secret, T0);
  service.totpEnable(SESSION, code);
  await rejectsWith(service.login('alice', 'right-password', code), 'AUTH_INVALID_TOTP');
});

test('setup is refused while 2FA is on, so a session cannot swap the secret', async () => {
  const { service } = harness(T0);
  const { secret } = service.totpSetup(SESSION);
  service.totpEnable(SESSION, totp(secret, T0));
  assert.throws(() => service.totpSetup(SESSION), (e: unknown) => e instanceof AppError && e.code === 'AUTH_TOTP_ALREADY_ENABLED');
});

test('turning 2FA off needs the password and a current code', async () => {
  const { service, clock } = harness(T0);
  const { secret } = service.totpSetup(SESSION);
  service.totpEnable(SESSION, totp(secret, T0));
  clock.now = T0 + 90_000;
  await rejectsWith(service.totpDisable(SESSION, 'right-password', '000000'), 'AUTH_INVALID_TOTP');
  await rejectsWith(service.totpDisable(SESSION, 'wrong', totp(secret, clock.now)), 'AUTH_INVALID_CREDENTIALS');
  assert.deepEqual(await service.totpDisable(SESSION, 'right-password', totp(secret, clock.now)), { enabled: false });
  assert.equal((await service.login('alice', 'right-password')).token, 'signed-token');
});

test('the consent re-confirmation checks the password only', async () => {
  const { service } = harness(T0);
  const { secret } = service.totpSetup(SESSION);
  service.totpEnable(SESSION, totp(secret, T0));
  const verify = createCredentialVerifier(service);
  assert.deepEqual(await verify('alice', 'right-password'), { ok: true, userId: 7 });
  assert.deepEqual(await verify('alice', 'wrong'), { ok: false });
});
