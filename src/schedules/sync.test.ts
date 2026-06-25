import { describe, expect, it, vi } from "vitest";
import { removeScheduler, upsertScheduler } from "./sync.js";
import type { ScheduleRecord } from "./store.js";

const record: ScheduleRecord = {
  id: "id-1",
  name: "pinfinity-ping",
  cron: "*/10 * * * *",
  tz: "Europe/Vienna",
  jobType: "integrations.ping",
  payload: { message: "tick" },
  consumer: "pinfinity",
  active: true,
  createdAt: "2026-06-25T00:00:00.000Z",
};

describe("scheduler sync", () => {
  it("upsertet mit cron-pattern, tz und job-data-form des POST /jobs-pfads", async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined), removeJobScheduler: vi.fn() };
    await upsertScheduler(queue, record);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "pinfinity-ping",
      { pattern: "*/10 * * * *", tz: "Europe/Vienna" },
      {
        name: "integrations.ping",
        data: { payload: { message: "tick" }, consumer: "pinfinity", tenant: null, callbackUrl: null },
      },
    );
  });

  it("entfernt nach scheduler-id (name)", async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn().mockResolvedValue(true) };
    const ok = await removeScheduler(queue, "pinfinity-ping");
    expect(ok).toBe(true);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("pinfinity-ping");
  });
});
