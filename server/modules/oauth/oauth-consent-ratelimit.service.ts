/**
 * Per-source password-submission rate limiter for the consent decision endpoint
 * (AC-261, restored on the SPA data plane by
 * gap-ac261-consent-password-ratelimit-restore).
 *
 * The consent SPA authenticates the browser user with their local password
 * before it will issue an authorization code (`oauth-consent.routes.ts` calls
 * the injected credential verifier in the `allow` branch). That check is a
 * password oracle, so it must be bounded: ten failures per source per fifteen
 * minutes, and the eleventh attempt is refused whether or not its password is
 * correct — otherwise an attacker who lifted a session JWT could brute-force the
 * account's password from the same machine.
 *
 * The limiter is deliberately a FIXED window, not sliding: the AC pins "ten in
 * fifteen minutes" as a count within one window, and a fixed window makes an
 * injected clock (`now`) advance the state deterministically — the criterion
 * never sleeps real time.
 *
 * SOURCE is the whole point of the `trustProxy` switch. Behind Cloudflare (the
 * deployment this endpoint serves) the socket peer is the edge, so every real
 * client shares one bucket unless the proxy header is read. When `TRUST_PROXY`
 * is unset the header is attacker-controlled and reading it would let one client
 * spread its attempts across unlimited forged identities, so the socket address
 * is used and every header is ignored. `resolveSource` is the single place that
 * decides.
 *
 * Consumers: `oauth-consent.routes.ts` (the consent JSON API) and this module's
 * criterion `tests/oauth-consent-ratelimit.test.ts`.
 */

/**
 * The narrow slice of an HTTP request the source resolver reads: the socket's
 * peer address and a header getter. Kept structural (not `express.Request`) so
 * the resolver can be exercised without a live server.
 */
export type ConsentRateLimitRequest = {
  socket?: { remoteAddress?: string | null } | null;
  get(name: string): string | undefined;
};

/** Caller-supplied seams for {@link createConsentPasswordRateLimiter}. */
export type ConsentPasswordRateLimiterOptions = {
  /** Injectable clock; defaults to `() => new Date()`. The criterion advances this. */
  now?: () => Date;
  /** Length of one fixed window; defaults to fifteen minutes. */
  windowMs?: number;
  /** Failures allowed within a window before the source is blocked; defaults to ten. */
  maxAttempts?: number;
  /** Whether the source may come from `CF-Connecting-IP`; defaults to `TRUST_PROXY` being set. */
  trustProxy?: boolean;
};

/** The per-source password limiter the consent decision endpoint consults. */
export type ConsentPasswordRateLimiter = {
  /** The rate-limit key for a request: the proxy-forwarded client or the socket peer. */
  source(req: ConsentRateLimitRequest): string;
  /** Whether `source` has already spent its attempts in the current window. */
  isBlocked(source: string): boolean;
  /** Counts one failed password check for `source`, opening a window when none is live. */
  recordFailure(source: string): void;
  /** Clears `source`'s bucket only (a successful confirmation); other sources are untouched. */
  resetSource(source: string): void;
  /** Milliseconds until `source`'s window rolls over (0 when it is not blocked). */
  retryAfterMs(source: string): number;
};

/** Fifteen minutes, the AC's window. */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
/** Ten attempts, the AC's allowance. */
const DEFAULT_MAX_ATTEMPTS = 10;
/** The key used when the transport cannot name a peer address (never expected in production). */
const UNKNOWN_SOURCE = 'unknown';

/** `TRUST_PROXY` is the deployment's declaration that a header-forwarding edge sits in front of us. */
function defaultTrustProxy(): boolean {
  return String(process.env.TRUST_PROXY ?? '').trim() !== '';
}

/**
 * The single source-resolution rule. With `trustProxy` the `CF-Connecting-IP`
 * header wins when it carries a non-blank value and otherwise the socket peer is
 * the fallback; without it the header is ignored entirely, because an unproxied
 * deployment would be letting the client choose its own rate-limit key.
 */
function resolveSource(req: ConsentRateLimitRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.get('CF-Connecting-IP');
    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
      return forwarded.trim();
    }
  }
  const remote = req.socket?.remoteAddress;
  return typeof remote === 'string' && remote !== '' ? remote : UNKNOWN_SOURCE;
}

/**
 * Builds a fixed-window, per-source counter over a `Map`. Each bucket is
 * `{count, windowStart}`; a bucket whose age reaches `windowMs` is expired and is
 * reset before it is read, so the next attempt after a window opens a fresh one.
 */
export function createConsentPasswordRateLimiter(
  options: ConsentPasswordRateLimiterOptions = {}
): ConsentPasswordRateLimiter {
  const now = options.now ?? ((): Date => new Date());
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const trustProxy = options.trustProxy ?? defaultTrustProxy();
  const buckets = new Map<string, { count: number; windowStart: number }>();

  const at = (): number => now().getTime();
  const expired = (bucket: { windowStart: number }, time: number): boolean =>
    time - bucket.windowStart >= windowMs;

  // Drops every expired bucket so an unbounded set of one-off sources cannot
  // grow the map without limit. `retryAfterMs` is the natural place for it: it is
  // called on the refusal path only, never on the hot record path.
  const prune = (time: number): void => {
    for (const [source, bucket] of buckets) {
      if (expired(bucket, time)) {
        buckets.delete(source);
      }
    }
  };

  return {
    source(req: ConsentRateLimitRequest): string {
      return resolveSource(req, trustProxy);
    },

    isBlocked(source: string): boolean {
      const time = at();
      const bucket = buckets.get(source);
      if (bucket === undefined) {
        return false;
      }
      if (expired(bucket, time)) {
        buckets.delete(source);
        return false;
      }
      return bucket.count >= maxAttempts;
    },

    recordFailure(source: string): void {
      const time = at();
      const bucket = buckets.get(source);
      if (bucket === undefined || expired(bucket, time)) {
        buckets.set(source, { count: 1, windowStart: time });
        return;
      }
      bucket.count += 1;
    },

    resetSource(source: string): void {
      buckets.delete(source);
    },

    retryAfterMs(source: string): number {
      const time = at();
      prune(time);
      const bucket = buckets.get(source);
      if (bucket === undefined) {
        return 0;
      }
      const remaining = bucket.windowStart + windowMs - time;
      return remaining > 0 ? remaining : 0;
    },
  };
}
