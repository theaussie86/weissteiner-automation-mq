import { UnrecoverableError } from "bullmq";

// Endgültiges Scheitern (GLOSSARY.md: "Endgültiges Scheitern"): ein fehlgeschlagener
// Versuch ist erst dann nach außen endgültig, wenn kein Retry mehr folgt. BullMQ feuert
// das `failed`-Event bei JEDEM Versuch — Archiv und Callback dürfen aber erst beim
// letzten Versuch oder bei einem nicht wiederholbaren Fehler laufen (Ticket #8).

export interface FailableJob {
  id?: string;
  name?: string;
  attemptsMade: number;
  opts: { attempts?: number };
}

/**
 * Reine Funktion: ist dieser Fehlversuch endgültig?
 * - UnrecoverableError wird nie wiederholt => immer final.
 * - Sonst final, wenn der gemachte Versuch der letzte war (attemptsMade >= attempts, Default 1).
 * - Fehlender Job: als final behandeln (keine Retry-Info vorhanden).
 */
export function isFinalFailure(
  job: Pick<FailableJob, "attemptsMade" | "opts"> | undefined,
  err: unknown,
): boolean {
  if (err instanceof UnrecoverableError) return true;
  if (!job) return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

export interface FailedHandlerDeps {
  queue: string;
  /** Schreibt den endgültigen Fehlschlag ins Archiv. */
  archiveFailed: (jobId: string, error: string) => void;
  /** Sendet den Fehler-Callback nach außen. */
  notifyFailed: (error: string) => void;
  /**
   * Hook des Job-Typs auf das endgültige Scheitern (Ticket #9). Wird nur beim letzten
   * Versuch aufgerufen. Fehler (synchron oder als Rejection) werden geschluckt und als
   * `onFinalFailure.error` geloggt — sie brechen die Fehlerbehandlung nicht.
   */
  onFinalFailure?: (() => void | Promise<void>) | undefined;
  /** Log-Ausgabe (Default console.error). */
  log?: (line: string) => void;
}

/**
 * Gemeinsame Logik des `failed`-Handlers. Bei Zwischenfehlern nur Log `retry_scheduled`,
 * kein Archiv, kein Callback, kein Hook. Erst beim endgültigen Scheitern Archiv +
 * Callback + onFinalFailure-Hook.
 */
export function handleFailed(job: FailableJob | undefined, err: Error, deps: FailedHandlerDeps): void {
  const log = deps.log ?? ((line: string) => console.error(line));
  if (!isFinalFailure(job, err)) {
    log(
      JSON.stringify({
        event: "retry_scheduled",
        jobId: job?.id,
        type: job?.name,
        attempt: job?.attemptsMade,
        maxAttempts: job?.opts.attempts ?? 1,
        error: err.message,
      }),
    );
    return;
  }
  log(JSON.stringify({ event: "failed", queue: deps.queue, jobId: job?.id, type: job?.name, error: err.message }));
  if (job?.id) {
    deps.archiveFailed(job.id, err.message);
    deps.notifyFailed(err.message);
  }
  if (deps.onFinalFailure) {
    const logHookError = (hookErr: unknown) =>
      log(
        JSON.stringify({
          event: "onFinalFailure.error",
          queue: deps.queue,
          jobId: job?.id,
          type: job?.name,
          error: (hookErr as Error).message,
        }),
      );
    try {
      // Synchron aufrufen, damit der Hook nachweisbar genau einmal läuft; eine
      // zurückgegebene Promise fangen wir zusätzlich ab (fire-and-forget wie der Callback).
      const result = deps.onFinalFailure();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).catch(logHookError);
      }
    } catch (hookErr) {
      logHookError(hookErr);
    }
  }
}
