import type { JobsOptions } from "bullmq";

// jobId-Muster laut Ticket #6: kein ":" (BullMQ verbietet es in Custom-IDs).
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

// Schmaler Queue-Seam: nur was enqueueJob braucht, damit Tests mit einem Fake arbeiten
// können. Die echte BullMQ-Queue erfüllt diese Form strukturell.
export interface EnqueueableJob {
  id?: string | undefined;
  getState(): Promise<string>;
  remove(): Promise<unknown>;
}

export interface EnqueueQueue {
  getJob(jobId: string): Promise<EnqueueableJob | undefined | null>;
  add(name: string, data: unknown, opts: JobsOptions): Promise<EnqueueableJob>;
}

export interface EnqueueOptions {
  jobId?: string | undefined;
  delay?: number | undefined;
  attempts?: number | undefined;
  backoff?: JobsOptions["backoff"] | undefined;
  onExisting?: "skip" | "replace" | undefined;
}

export type EnqueueOutcome = "enqueued" | "deduplicated" | "active";

export interface EnqueueResult {
  outcome: EnqueueOutcome;
  job: EnqueueableJob;
}

// Legt einen Job an und respektiert eine optionale Custom-jobId:
// - aktiver Job mit der ID => "active" (Aufrufer: 409, nicht abbrechbar).
// - wartender/verzögerter Job + onExisting "skip" (Default) => "deduplicated" (kein neuer Job).
// - wartender/verzögerter Job + "replace" => alten entfernen, neu anlegen.
// - abgeschlossener/fehlgeschlagener Job => entfernen, damit die ID wieder frei wird, neu anlegen.
export async function enqueueJob(
  queue: EnqueueQueue,
  name: string,
  data: unknown,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const addOpts: JobsOptions = {};
  if (opts.attempts !== undefined) addOpts.attempts = opts.attempts;
  if (opts.backoff !== undefined) addOpts.backoff = opts.backoff;
  if (opts.delay !== undefined) addOpts.delay = opts.delay;

  if (opts.jobId !== undefined) {
    addOpts.jobId = opts.jobId;
    const existing = await queue.getJob(opts.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active") {
        return { outcome: "active", job: existing };
      }
      const pending =
        state === "waiting" || state === "delayed" || state === "prioritized" || state === "waiting-children";
      if (pending && (opts.onExisting ?? "skip") === "skip") {
        return { outcome: "deduplicated", job: existing };
      }
      // Entweder "replace" eines wartenden Jobs oder Wiederverwendung einer
      // completed/failed-ID: alten Eintrag entfernen, damit add() die ID bekommt.
      await existing.remove();
    }
  }

  const job = await queue.add(name, data, addOpts);
  return { outcome: "enqueued", job };
}

export interface JobOptionsInput {
  delay?: unknown;
  jobId?: unknown;
  onExisting?: unknown;
}

export interface ParsedJobOptions {
  delay?: number;
  jobId?: string;
  onExisting?: "skip" | "replace";
}

// Reine Validierung der optionalen POST /jobs-Felder. Trennt die HTTP-Schicht vom
// Prüf-Code, damit die 422-Fälle unit-testbar sind.
export function parseJobOptions(
  input: JobOptionsInput,
): { ok: true; value: ParsedJobOptions } | { ok: false; error: string } {
  const value: ParsedJobOptions = {};
  if (input.delay !== undefined) {
    if (typeof input.delay !== "number" || !Number.isInteger(input.delay) || input.delay < 0) {
      return { ok: false, error: "Invalid delay: non-negative integer milliseconds" };
    }
    value.delay = input.delay;
  }
  if (input.jobId !== undefined) {
    if (typeof input.jobId !== "string" || !JOB_ID_PATTERN.test(input.jobId)) {
      return { ok: false, error: "Invalid jobId: letters, digits, underscore, hyphen, max 200 chars (no ':')" };
    }
    value.jobId = input.jobId;
  }
  if (input.onExisting !== undefined) {
    if (input.onExisting !== "skip" && input.onExisting !== "replace") {
      return { ok: false, error: "Invalid onExisting: 'skip' or 'replace'" };
    }
    value.onExisting = input.onExisting;
  }
  return { ok: true, value };
}
