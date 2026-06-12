import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, hasQueueScope, safeEqual } from "./auth.js";

describe("auth", () => {
  it("generates prefixed 48-hex-char keys", () => {
    const key = generateApiKey();
    expect(key).toMatch(/^mq_[0-9a-f]{48}$/);
    expect(generateApiKey()).not.toBe(key);
  });

  it("hashes deterministically", () => {
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
    expect(hashApiKey("abc")).not.toBe(hashApiKey("abd"));
  });

  it("checks queue scopes incl. wildcard", () => {
    const consumer = { id: "1", name: "n8n", queueScopes: ["media"] };
    expect(hasQueueScope(consumer, "media")).toBe(true);
    expect(hasQueueScope(consumer, "integrations")).toBe(false);
    expect(hasQueueScope({ ...consumer, queueScopes: ["*"] }, "integrations")).toBe(true);
  });

  it("safeEqual compares without length leak", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("short", "much-longer-value")).toBe(false);
  });
});
