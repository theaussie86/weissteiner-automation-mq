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
