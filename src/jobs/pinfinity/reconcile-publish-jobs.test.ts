import { describe, expect, it, vi } from "vitest";
import {
  reconcilePublishJobs,
  type ReconcilablePin,
  type ReconcileClient,
} from "./reconcile-publish-jobs.js";
import type { ContextEnqueue, EnqueueResult, EnqueueableJob } from "../enqueue.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function fakeClient(pins: ReconcilablePin[]): ReconcileClient {
  return { listReconcilablePins: async () => pins };
}

// Fake-Queue: merkt sich jobIds. Unbekannte ID => "enqueued", bekannte => "deduplicated".
// Simuliert damit ctx.enqueue mit onExisting: skip über mehrere Läufe hinweg.
function fakeEnqueue(seen: Set<string> = new Set()): {
  enqueue: ContextEnqueue;
  calls: { type: string; payload: unknown; opts: Record<string, unknown> | undefined }[];
} {
  const calls: { type: string; payload: unknown; opts: Record<string, unknown> | undefined }[] = [];
  const enqueue: ContextEnqueue = async (type, payload, opts) => {
    calls.push({ type, payload, opts });
    const jobId = opts?.jobId as string;
    const outcome = seen.has(jobId) ? "deduplicated" : "enqueued";
    if (outcome === "enqueued") seen.add(jobId);
    const job = { id: jobId } as EnqueueableJob;
    return { outcome, job } as EnqueueResult;
  };
  return { enqueue, calls };
}

const baseOpts = { supabaseCredential: "pinfinity-supabase", horizonDays: 14, dryRun: false, now: () => NOW };

describe("reconcilePublishJobs", () => {
  it("Auswahl-Filter: nur Pins im Horizont werden eingereiht", async () => {
    const within = new Date(NOW_MS + 5 * 24 * 3600 * 1000).toISOString();
    const beyond = new Date(NOW_MS + 30 * 24 * 3600 * 1000).toISOString();
    const client = fakeClient([
      { id: "p-within", scheduled_at: within },
      { id: "p-beyond", scheduled_at: beyond },
    ]);
    const { enqueue, calls } = fakeEnqueue();
    const result = await reconcilePublishJobs(client, enqueue, baseOpts);
    expect(result).toEqual({ total: 1, enqueued: 1, alreadyQueued: 0, dryRun: false });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.opts as { jobId: string }).jobId).toBe("publish-pin-p-within");
  });

  it("Delay-Berechnung: fälliger Pin delay 0, künftiger Pin delay = scheduled_at - now", async () => {
    const overdue = new Date(NOW_MS - 3600 * 1000).toISOString();
    const future = new Date(NOW_MS + 2 * 3600 * 1000).toISOString();
    const client = fakeClient([
      { id: "p-overdue", scheduled_at: overdue },
      { id: "p-future", scheduled_at: future },
    ]);
    const { enqueue, calls } = fakeEnqueue();
    await reconcilePublishJobs(client, enqueue, baseOpts);
    expect((calls[0]!.opts as { delay: number }).delay).toBe(0);
    expect((calls[1]!.opts as { delay: number }).delay).toBe(2 * 3600 * 1000);
    expect(calls[0]!.payload).toEqual({
      supabaseCredential: "pinfinity-supabase",
      pinId: "p-overdue",
      scheduledAt: overdue,
    });
    expect((calls[0]!.opts as { onExisting: string }).onExisting).toBe("skip");
  });

  it("Idempotenz: zweiter Lauf reiht nichts neu ein (alreadyQueued)", async () => {
    const at = new Date(NOW_MS + 24 * 3600 * 1000).toISOString();
    const client = fakeClient([{ id: "p1", scheduled_at: at }]);
    const seen = new Set<string>();
    const first = fakeEnqueue(seen);
    const firstResult = await reconcilePublishJobs(client, first.enqueue, baseOpts);
    expect(firstResult).toEqual({ total: 1, enqueued: 1, alreadyQueued: 0, dryRun: false });

    const second = fakeEnqueue(seen);
    const secondResult = await reconcilePublishJobs(client, second.enqueue, baseOpts);
    expect(secondResult).toEqual({ total: 1, enqueued: 0, alreadyQueued: 1, dryRun: false });
  });

  it("Dry-Run: zählt total, reiht aber nichts ein", async () => {
    const at = new Date(NOW_MS + 24 * 3600 * 1000).toISOString();
    const client = fakeClient([
      { id: "p1", scheduled_at: at },
      { id: "p2", scheduled_at: at },
    ]);
    const { enqueue, calls } = fakeEnqueue();
    const spy = vi.fn(enqueue);
    const result = await reconcilePublishJobs(client, spy, { ...baseOpts, dryRun: true });
    expect(result).toEqual({ total: 2, enqueued: 0, alreadyQueued: 0, dryRun: true });
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("keine Kandidaten: total 0, nichts eingereiht", async () => {
    const { enqueue, calls } = fakeEnqueue();
    const result = await reconcilePublishJobs(fakeClient([]), enqueue, baseOpts);
    expect(result).toEqual({ total: 0, enqueued: 0, alreadyQueued: 0, dryRun: false });
    expect(calls).toHaveLength(0);
  });
});
