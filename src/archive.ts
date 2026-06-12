import type pg from "pg";

// Job-Archiv (CONTEXT.md): persistierte Job-Historie, unabhängig vom flüchtigen
// Redis-State. Archiv-Schreibfehler dürfen nie die Job-Verarbeitung brechen —
// alle Funktionen loggen und schlucken Fehler.

export interface ArchiveEntry {
  jobId: string;
  queue: string;
  type: string;
  consumer: string;
  tenant?: string | undefined;
  payload?: unknown;
}

export async function archiveQueued(db: pg.Pool, entry: ArchiveEntry): Promise<void> {
  try {
    await db.query(
      `insert into job_archive (job_id, queue, type, consumer, tenant, payload)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (queue, job_id) do nothing`,
      [entry.jobId, entry.queue, entry.type, entry.consumer, entry.tenant ?? null, JSON.stringify(entry.payload ?? null)],
    );
  } catch (err) {
    console.error(JSON.stringify({ event: "archive.error", op: "queued", jobId: entry.jobId, error: (err as Error).message }));
  }
}

export async function archiveFinished(
  db: pg.Pool,
  queue: string,
  jobId: string,
  outcome: { status: "completed"; result: unknown } | { status: "failed"; error: string },
): Promise<void> {
  try {
    await db.query(
      `update job_archive
       set status = $3, result = $4, error = $5, finished_at = now()
       where queue = $1 and job_id = $2`,
      [
        queue,
        jobId,
        outcome.status,
        JSON.stringify(outcome.status === "completed" ? outcome.result ?? null : null),
        outcome.status === "failed" ? outcome.error : null,
      ],
    );
  } catch (err) {
    console.error(JSON.stringify({ event: "archive.error", op: "finished", jobId, error: (err as Error).message }));
  }
}
