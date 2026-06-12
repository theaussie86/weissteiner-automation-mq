import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  REDIS_URL: "redis://localhost:6379",
  DATABASE_URL: "postgres://localhost:5432/mq",
};

describe("loadConfig", () => {
  it("parses minimal env with defaults", () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(3000);
    expect(config.WORKER_QUEUES).toEqual(["media", "integrations"]);
  });

  it("splits WORKER_QUEUES on comma", () => {
    const config = loadConfig({ ...base, WORKER_QUEUES: "media, flows" });
    expect(config.WORKER_QUEUES).toEqual(["media", "flows"]);
  });

  it("throws on missing REDIS_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/REDIS_URL/);
  });
});

describe("ADMIN_KEY", () => {
  it("treats empty string as unset", () => {
    const config = loadConfig({ ...base, ADMIN_KEY: "" });
    expect(config.ADMIN_KEY).toBeUndefined();
  });

  it("rejects short keys", () => {
    expect(() => loadConfig({ ...base, ADMIN_KEY: "short" })).toThrow(/ADMIN_KEY/);
  });
});

describe("CREDENTIAL_MASTER_KEY", () => {
  it("accepts 32-byte base64 key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const config = loadConfig({ ...base, CREDENTIAL_MASTER_KEY: key });
    expect(config.CREDENTIAL_MASTER_KEY).toBe(key);
  });

  it("rejects keys that are not 32 bytes", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(() => loadConfig({ ...base, CREDENTIAL_MASTER_KEY: short })).toThrow(/CREDENTIAL_MASTER_KEY/);
  });

  it("treats empty string as unset", () => {
    const config = loadConfig({ ...base, CREDENTIAL_MASTER_KEY: "" });
    expect(config.CREDENTIAL_MASTER_KEY).toBeUndefined();
  });
});

describe("OAuth client config", () => {
  it("treats empty strings as unset", () => {
    const config = loadConfig({ ...base, GOOGLE_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "" });
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.SHOPIFY_CLIENT_SECRET).toBeUndefined();
  });
});
