import { describe, expect, it, vi } from "vitest";
import {
  enqueueJob,
  parseJobOptions,
  type EnqueueableJob,
  type EnqueueQueue,
} from "./enqueue.js";

function fakeJob(id: string, state: string): EnqueueableJob & { getState: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return {
    id,
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => undefined),
  };
}

function fakeQueue(existing?: EnqueueableJob): {
  queue: EnqueueQueue;
  add: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
} {
  const add = vi.fn(async (_name: string, _data: unknown, opts) => fakeJob(opts.jobId ?? "auto-id", "waiting"));
  const getJob = vi.fn(async () => existing ?? undefined);
  return { queue: { add, getJob }, add, getJob };
}

describe("enqueueJob", () => {
  it("legt ohne jobId einfach an und reicht delay/attempts/backoff an add() durch", async () => {
    const { queue, add, getJob } = fakeQueue();
    const result = await enqueueJob(queue, "integrations.ping", { payload: 1 }, {
      delay: 5000,
      attempts: 4,
      backoff: { type: "exponential", delay: 300000 },
    });
    expect(result.outcome).toBe("enqueued");
    expect(getJob).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith("integrations.ping", { payload: 1 }, {
      delay: 5000,
      attempts: 4,
      backoff: { type: "exponential", delay: 300000 },
    });
  });

  it("legt mit jobId an, wenn keiner existiert", async () => {
    const { queue, add } = fakeQueue();
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1" });
    expect(result.outcome).toBe("enqueued");
    expect(add).toHaveBeenCalledWith("t", {}, { jobId: "publish-pin-1" });
  });

  it("skip + wartender Job => deduplicated, kein add", async () => {
    const existing = fakeJob("publish-pin-1", "waiting");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1", onExisting: "skip" });
    expect(result.outcome).toBe("deduplicated");
    expect(result.job).toBe(existing);
    expect(add).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
  });

  it("skip ist Default bei verzögertem Job", async () => {
    const existing = fakeJob("publish-pin-1", "delayed");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1" });
    expect(result.outcome).toBe("deduplicated");
    expect(add).not.toHaveBeenCalled();
  });

  it("replace + wartender Job => alten entfernen, neu anlegen", async () => {
    const existing = fakeJob("publish-pin-1", "delayed");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", { v: 2 }, { jobId: "publish-pin-1", onExisting: "replace" });
    expect(result.outcome).toBe("enqueued");
    expect(existing.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("t", { v: 2 }, { jobId: "publish-pin-1" });
  });

  it("aktiver Job => active, kein add, kein remove", async () => {
    const existing = fakeJob("publish-pin-1", "active");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1", onExisting: "replace" });
    expect(result.outcome).toBe("active");
    expect(add).not.toHaveBeenCalled();
    expect(existing.remove).not.toHaveBeenCalled();
  });

  it("completed Job => entfernen, neu anlegen (auch bei skip)", async () => {
    const existing = fakeJob("publish-pin-1", "completed");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1", onExisting: "skip" });
    expect(result.outcome).toBe("enqueued");
    expect(existing.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledOnce();
  });

  it("failed Job => entfernen, neu anlegen", async () => {
    const existing = fakeJob("publish-pin-1", "failed");
    const { queue, add } = fakeQueue(existing);
    const result = await enqueueJob(queue, "t", {}, { jobId: "publish-pin-1" });
    expect(result.outcome).toBe("enqueued");
    expect(existing.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledOnce();
  });
});

describe("parseJobOptions", () => {
  it("leeres Objekt ist ok", () => {
    expect(parseJobOptions({})).toEqual({ ok: true, value: {} });
  });

  it("gültige Werte werden übernommen", () => {
    expect(parseJobOptions({ delay: 1000, jobId: "publish-pin-1", onExisting: "replace" })).toEqual({
      ok: true,
      value: { delay: 1000, jobId: "publish-pin-1", onExisting: "replace" },
    });
  });

  it("delay muss nicht-negative ganze Zahl sein", () => {
    expect(parseJobOptions({ delay: -1 }).ok).toBe(false);
    expect(parseJobOptions({ delay: 1.5 }).ok).toBe(false);
    expect(parseJobOptions({ delay: "100" }).ok).toBe(false);
  });

  it("jobId muss dem Muster entsprechen (kein ':')", () => {
    expect(parseJobOptions({ jobId: "publish:pin:1" }).ok).toBe(false);
    expect(parseJobOptions({ jobId: "" }).ok).toBe(false);
    expect(parseJobOptions({ jobId: "x".repeat(201) }).ok).toBe(false);
    expect(parseJobOptions({ jobId: 123 }).ok).toBe(false);
  });

  it("onExisting muss skip oder replace sein", () => {
    expect(parseJobOptions({ onExisting: "nope" }).ok).toBe(false);
    expect(parseJobOptions({ onExisting: "skip" }).ok).toBe(true);
  });
});
