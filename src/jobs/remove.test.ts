import { describe, expect, it, vi } from "vitest";
import { handleRemoveJob, type RemovableJob, type RemoveQueue } from "./remove.js";
import type { Consumer } from "../auth.js";

function consumer(scopes: string[]): Consumer {
  return { id: "c1", name: "pinfinity", queueScopes: scopes };
}

function fakeJob(id: string, state: string): RemovableJob & { remove: ReturnType<typeof vi.fn> } {
  return {
    id,
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => undefined),
  };
}

function deps(opts: {
  scopes?: string[];
  queue?: string;
  jobId?: string;
  job?: RemovableJob | undefined;
}) {
  const getJob = vi.fn(async () => opts.job ?? undefined);
  const queue: RemoveQueue = { getJob };
  const getQueue = vi.fn(() => queue);
  const onRemoved = vi.fn(async () => undefined);
  return {
    args: {
      consumer: consumer(opts.scopes ?? ["integrations"]),
      queue: opts.queue ?? "integrations",
      jobId: opts.jobId ?? "publish-pin-1",
      getQueue,
      onRemoved,
    },
    getJob,
    getQueue,
    onRemoved,
  };
}

describe("handleRemoveJob", () => {
  it("unbekannte Queue => 422, bevor irgendetwas angefasst wird", async () => {
    const { args, getQueue, onRemoved } = deps({ queue: "nope", scopes: ["*"] });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(422);
    expect(getQueue).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("fehlender Scope => 403", async () => {
    const { args, getQueue } = deps({ scopes: ["media"] });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(403);
    expect(getQueue).not.toHaveBeenCalled();
  });

  it("Wildcard-Scope erlaubt Zugriff auf jede bekannte Queue", async () => {
    const { args } = deps({ scopes: ["*"], job: undefined });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(404);
  });

  it("Job nicht gefunden => 404", async () => {
    const { args, onRemoved } = deps({ job: undefined });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(404);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("aktiver Job => 409, kein remove, kein onRemoved", async () => {
    const job = fakeJob("publish-pin-1", "active");
    const { args, onRemoved } = deps({ job });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ state: "active" });
    expect(job.remove).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("wartender Job => entfernt, 200 removed:true, onRemoved aufgerufen", async () => {
    const job = fakeJob("publish-pin-1", "waiting");
    const { args, onRemoved } = deps({ job });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: true });
    expect(job.remove).toHaveBeenCalledOnce();
    expect(onRemoved).toHaveBeenCalledWith("integrations", "publish-pin-1");
  });

  it("verzögerter Job => entfernt, 200 removed:true", async () => {
    const job = fakeJob("publish-pin-1", "delayed");
    const { args } = deps({ job });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: true });
    expect(job.remove).toHaveBeenCalledOnce();
  });

  it("abgeschlossener Job => 200 removed:false mit state, kein remove, kein onRemoved", async () => {
    const job = fakeJob("publish-pin-1", "completed");
    const { args, onRemoved } = deps({ job });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: false, state: "completed" });
    expect(job.remove).not.toHaveBeenCalled();
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("fehlgeschlagener Job => 200 removed:false mit state", async () => {
    const job = fakeJob("publish-pin-1", "failed");
    const { args } = deps({ job });
    const result = await handleRemoveJob(args);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ removed: false, state: "failed" });
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("funktioniert auch ohne onRemoved-Hook", async () => {
    const job = fakeJob("publish-pin-1", "waiting");
    const getJob = vi.fn(async () => job);
    const result = await handleRemoveJob({
      consumer: consumer(["integrations"]),
      queue: "integrations",
      jobId: "publish-pin-1",
      getQueue: () => ({ getJob }),
    });
    expect(result.status).toBe(200);
    expect(job.remove).toHaveBeenCalledOnce();
  });
});
