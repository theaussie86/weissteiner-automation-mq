import { hasQueueScope, type Consumer } from "../auth.js";
import { QUEUES } from "./registry.js";

// Schmaler Queue-Seam für DELETE /jobs (Ticket #7): nur was handleRemoveJob braucht,
// damit Tests mit einem Fake arbeiten können. Die echte BullMQ-Queue erfüllt diese Form.
export interface RemovableJob {
  id?: string | undefined;
  getState(): Promise<string>;
  remove(): Promise<unknown>;
}

export interface RemoveQueue {
  getJob(jobId: string): Promise<RemovableJob | undefined | null>;
}

export interface RemoveJobDeps {
  consumer: Consumer;
  queue: string;
  jobId: string;
  getQueue: (name: string) => RemoveQueue;
  /** Markiert den Archiv-Eintrag als abgebrochen — nur wenn der Job wirklich entfernt wurde. */
  onRemoved?: (queue: string, jobId: string) => Promise<void> | void;
}

export type RemoveJobResult =
  | { status: 422; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 409; body: { error: string; state: string } }
  | { status: 200; body: { removed: true } }
  | { status: 200; body: { removed: false; state: string } };

function isKnownQueue(name: string): boolean {
  return (QUEUES as readonly string[]).includes(name);
}

// Entfernt einen noch nicht laufenden Job (Ticket #7). Reihenfolge der Prüfungen:
// erst die Zielressource validieren (unbekannte Queue => 422), dann autorisieren
// (fehlender Scope => 403) — analog zu POST /jobs (unbekannter Typ vor Scope).
// Nur wartende/verzögerte Jobs sind abbrechbar; aktive schützt zusätzlich ihr
// Stale-Guard. Abgeschlossene/fehlgeschlagene Jobs sind ein No-op (removed:false).
export async function handleRemoveJob(deps: RemoveJobDeps): Promise<RemoveJobResult> {
  if (!isKnownQueue(deps.queue)) {
    return { status: 422, body: { error: `Unknown queue: ${deps.queue}` } };
  }
  if (!hasQueueScope(deps.consumer, deps.queue)) {
    return { status: 403, body: { error: `No scope for queue: ${deps.queue}` } };
  }
  const job = await deps.getQueue(deps.queue).getJob(deps.jobId);
  if (!job) {
    return { status: 404, body: { error: "Job not found" } };
  }
  const state = await job.getState();
  if (state === "active") {
    return { status: 409, body: { error: "Job is active and cannot be removed", state } };
  }
  if (state === "completed" || state === "failed") {
    return { status: 200, body: { removed: false, state } };
  }
  await job.remove();
  await deps.onRemoved?.(deps.queue, deps.jobId);
  return { status: 200, body: { removed: true } };
}
