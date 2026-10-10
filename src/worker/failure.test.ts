import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { handleFailed, isFinalFailure, type FailableJob } from "./failure.js";

function job(attemptsMade: number, attempts?: number, id = "j1", name = "integrations.ping"): FailableJob {
  return { id, name, attemptsMade, opts: attempts === undefined ? {} : { attempts } };
}

describe("isFinalFailure", () => {
  it("ist final beim letzten Versuch", () => {
    expect(isFinalFailure(job(4, 4), new Error("boom"))).toBe(true);
  });

  it("ist nicht final bei einem Zwischenversuch", () => {
    expect(isFinalFailure(job(1, 4), new Error("boom"))).toBe(false);
    expect(isFinalFailure(job(3, 4), new Error("boom"))).toBe(false);
  });

  it("ist immer final bei UnrecoverableError, auch bei Zwischenversuch", () => {
    expect(isFinalFailure(job(1, 4), new UnrecoverableError("nope"))).toBe(true);
  });

  it("ist final ohne attempts (1 Versuch wie heute)", () => {
    expect(isFinalFailure(job(1, undefined), new Error("boom"))).toBe(true);
  });

  it("behandelt fehlenden Job als final", () => {
    expect(isFinalFailure(undefined, new Error("boom"))).toBe(true);
  });
});

describe("handleFailed", () => {
  function deps() {
    return {
      queue: "integrations",
      archiveFailed: vi.fn(),
      notifyFailed: vi.fn(),
      log: vi.fn(),
    };
  }

  it("ruft bei Zwischenfehler weder Archiv noch Callback auf, loggt nur retry_scheduled", () => {
    const d = deps();
    handleFailed(job(1, 4), new Error("boom"), d);
    expect(d.archiveFailed).not.toHaveBeenCalled();
    expect(d.notifyFailed).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(d.log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      event: "retry_scheduled",
      jobId: "j1",
      type: "integrations.ping",
      attempt: 1,
      maxAttempts: 4,
      error: "boom",
    });
  });

  it("archiviert und benachrichtigt beim endgültigen Scheitern genau einmal", () => {
    const d = deps();
    handleFailed(job(4, 4), new Error("boom"), d);
    expect(d.archiveFailed).toHaveBeenCalledTimes(1);
    expect(d.archiveFailed).toHaveBeenCalledWith("j1", "boom");
    expect(d.notifyFailed).toHaveBeenCalledTimes(1);
    expect(d.notifyFailed).toHaveBeenCalledWith("boom");
    const line = JSON.parse(d.log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ event: "failed", queue: "integrations", jobId: "j1" });
  });

  it("archiviert sofort bei UnrecoverableError im Zwischenversuch", () => {
    const d = deps();
    handleFailed(job(1, 4), new UnrecoverableError("nope"), d);
    expect(d.archiveFailed).toHaveBeenCalledTimes(1);
    expect(d.notifyFailed).toHaveBeenCalledTimes(1);
  });

  it("verhält sich ohne attempts wie heute: sofort final", () => {
    const d = deps();
    handleFailed(job(1, undefined), new Error("boom"), d);
    expect(d.archiveFailed).toHaveBeenCalledTimes(1);
    expect(d.notifyFailed).toHaveBeenCalledTimes(1);
  });
});
