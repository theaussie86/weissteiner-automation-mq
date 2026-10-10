import { describe, expect, it, vi } from "vitest";
import {
  acquireRateLimit,
  enforcePinterestRateLimit,
  pinterestRateLimitKey,
  PINTEREST_RATE_LIMIT_MS,
  type RateLimitRedis,
} from "./rate-limit.js";

class DeferSignal extends Error {}

function fakeRedis(opts: { setResult: "OK" | null; pttl?: number }): RateLimitRedis & { set: ReturnType<typeof vi.fn> } {
  const set = vi.fn(async () => opts.setResult);
  return { set, pttl: async () => opts.pttl ?? -2 } as RateLimitRedis & { set: ReturnType<typeof vi.fn> };
}

describe("pinterestRateLimitKey", () => {
  it("baut den Schlüssel pro Connection", () => {
    expect(pinterestRateLimitKey("conn-7")).toBe("pinterest-rl-conn-7");
  });
});

describe("acquireRateLimit", () => {
  it("SET NX PX erfolgreich => acquired", async () => {
    const redis = fakeRedis({ setResult: "OK" });
    const result = await acquireRateLimit(redis, "k", 10_000);
    expect(result).toEqual({ acquired: true });
    expect(redis.set).toHaveBeenCalledWith("k", "1", "PX", 10_000, "NX");
  });

  it("Marke belegt => remainingMs aus PTTL", async () => {
    const redis = fakeRedis({ setResult: null, pttl: 4200 });
    const result = await acquireRateLimit(redis, "k", 10_000);
    expect(result).toEqual({ acquired: false, remainingMs: 4200 });
  });

  it("PTTL <= 0 (Rennen) => volle Fensterdauer", async () => {
    const redis = fakeRedis({ setResult: null, pttl: -2 });
    const result = await acquireRateLimit(redis, "k", 10_000);
    expect(result).toEqual({ acquired: false, remainingMs: 10_000 });
  });
});

describe("enforcePinterestRateLimit", () => {
  it("Marke frei => kein defer", async () => {
    const redis = fakeRedis({ setResult: "OK" });
    const defer = vi.fn(async (): Promise<never> => {
      throw new DeferSignal();
    });
    await enforcePinterestRateLimit({ redis, defer }, "conn-7");
    expect(defer).not.toHaveBeenCalled();
  });

  it("Marke belegt => defer mit Restzeit plus Jitter, Promise löst nie auf", async () => {
    const redis = fakeRedis({ setResult: null, pttl: 4000 });
    const defer = vi.fn(async (): Promise<never> => {
      throw new DeferSignal();
    });
    // random 0.5 => Jitter floor(0.5 * 1000) = 500
    const err = await enforcePinterestRateLimit({ redis, defer, random: () => 0.5 }, "conn-7").catch((e) => e);
    expect(err).toBeInstanceOf(DeferSignal);
    expect(defer).toHaveBeenCalledWith(4500);
  });

  it("nutzt die Fensterkonstante als TTL", async () => {
    const redis = fakeRedis({ setResult: "OK" });
    const defer = vi.fn(async (): Promise<never> => {
      throw new DeferSignal();
    });
    await enforcePinterestRateLimit({ redis, defer }, "conn-7");
    expect(redis.set).toHaveBeenCalledWith("pinterest-rl-conn-7", "1", "PX", PINTEREST_RATE_LIMIT_MS, "NX");
  });
});
