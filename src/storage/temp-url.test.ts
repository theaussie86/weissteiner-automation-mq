import { describe, expect, it } from "vitest";
import { createTempUrl, verifyTempUrl } from "./temp-url.js";

const secret = "test-secret-0123456789";
const base = { baseUrl: "https://mq.example.com", secret, fileKey: "abc.mp3" };

function parse(url: string) {
  const u = new URL(url);
  return { exp: Number(u.searchParams.get("exp")), sig: u.searchParams.get("sig")! };
}

describe("temp urls", () => {
  it("roundtrips a valid url", () => {
    const { exp, sig } = parse(createTempUrl(base));
    expect(verifyTempUrl({ secret, fileKey: "abc.mp3", exp, sig })).toEqual({ valid: true });
  });

  it("rejects expired urls", () => {
    const now = 1_000_000_000_000;
    const { exp, sig } = parse(createTempUrl({ ...base, ttlSeconds: 60, now }));
    const verdict = verifyTempUrl({ secret, fileKey: "abc.mp3", exp, sig, now: now + 61_000 });
    expect(verdict).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects tampered key and exp", () => {
    const { exp, sig } = parse(createTempUrl(base));
    expect(verifyTempUrl({ secret, fileKey: "other.mp3", exp, sig }).reason).toBe("bad-signature");
    expect(verifyTempUrl({ secret, fileKey: "abc.mp3", exp: exp + 1, sig }).reason).toBe("bad-signature");
  });
});
