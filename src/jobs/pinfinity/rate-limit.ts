// Rate-Limit pro Pinterest-Connection (Ticket #13, Umbrella #5): Mit parallelen
// Workern (Concurrency 5 auf `integrations`) feuern sonst mehrere Pins derselben
// Connection gleichzeitig. Die Edge Function hielt dafür 10 s Pause zwischen Pins.
//
// Lösung (im Ticket entschieden): Redis-Marke `pinterest-rl-<connectionId>` per
// `SET NX PX`. Ist sie belegt, verschiebt der Job sich selbst per moveToDelayed +
// DelayedError um die Restzeit plus Jitter — das verbraucht keinen Attempt. Kein
// eigener Limiter, weil die Marke mit BullMQs vorhandenem Redis auskommt.
//
// Reine Orchestrierung gegen zwei schmale Seams (RateLimitRedis, defer), analog zu
// src/credentials/state.ts; der echte moveToDelayed-Adapter sitzt im Worker.

// Mindestabstand zwischen Pinterest-Aufrufen derselben Connection. Konfigurierbar.
export const PINTEREST_RATE_LIMIT_MS = 10_000;
// Jitter beim Verschieben verhindert, dass mehrere wartende Jobs derselben Connection
// nach Ablauf der Marke gleichzeitig wieder anlaufen (Thundering Herd).
export const PINTEREST_RATE_LIMIT_JITTER_MS = 1_000;

export function pinterestRateLimitKey(connectionId: string): string {
  return `pinterest-rl-${connectionId}`;
}

// Strukturelles Redis-Interface (wie StateRedis): hält das Modul ohne echtes Redis
// testbar. Erfüllt von ioredis.
export interface RateLimitRedis {
  set(key: string, value: string, px: "PX", ttlMs: number, nx: "NX"): Promise<string | null>;
  pttl(key: string): Promise<number>;
}

export type AcquireResult = { acquired: true } | { acquired: false; remainingMs: number };

// Belegt die Marke atomar per SET NX PX. Belegt => verbleibende TTL (PTTL) zurück.
export async function acquireRateLimit(redis: RateLimitRedis, key: string, ttlMs: number): Promise<AcquireResult> {
  const res = await redis.set(key, "1", "PX", ttlMs, "NX");
  if (res === "OK") return { acquired: true };
  const remainingMs = await redis.pttl(key);
  // -2 (Key weg) / -1 (kein TTL): Rennen zwischen SET und PTTL — volle Fensterdauer warten.
  return { acquired: false, remainingMs: remainingMs > 0 ? remainingMs : ttlMs };
}

export interface RateLimitContext {
  redis: RateLimitRedis;
  // Verschiebt den laufenden Job um delayMs (moveToDelayed + DelayedError); löst nie auf.
  defer: (delayMs: number) => Promise<never>;
  // Nur für Tests injizierbar; Default Math.random.
  random?: () => number;
}

// Hält den Mindestabstand pro Connection ein. Marke frei => sofort weiter. Belegt =>
// Job verschiebt sich selbst (verbraucht keinen Attempt) und diese Promise löst nie auf.
export async function enforcePinterestRateLimit(ctx: RateLimitContext, connectionId: string): Promise<void> {
  const result = await acquireRateLimit(ctx.redis, pinterestRateLimitKey(connectionId), PINTEREST_RATE_LIMIT_MS);
  if (result.acquired) return;
  const random = ctx.random ?? Math.random;
  const jitter = Math.floor(random() * PINTEREST_RATE_LIMIT_JITTER_MS);
  await ctx.defer(result.remainingMs + jitter);
}
