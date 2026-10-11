import { z } from "zod";
import type { JobsOptions } from "bullmq";
import type pg from "pg";
import type { Redis } from "ioredis";
import type { ContextEnqueue } from "./enqueue.js";
import type { FailableJob } from "../worker/failure.js";

export const QUEUES = ["media", "integrations"] as const;
export type QueueName = (typeof QUEUES)[number];

// Worker-seitiger Kontext: Credential-Zugriff und DB für Jobs, die mehr brauchen
// (z.B. Credential-Zugriff, Folge-Jobs). API ruft process nie auf.
export interface JobContext {
  db: pg.Pool;
  getCredential: (name: string) => Promise<Record<string, unknown>>;
  /**
   * Reiht einen Folge-Job ein (Ticket #9). Validiert das Payload gegen die Registry,
   * nutzt dieselben Optionen wie POST /jobs (jobId, delay, onExisting) und schreibt den
   * Archiv-Eintrag. Consumer/Tenant erbt der Folge-Job vom Ursprungsjob.
   */
  enqueue: ContextEnqueue;
  /** Aktive Redis-Verbindung für Jobs, die selbst Redis brauchen (z.B. Rate-Limit-Marke). */
  redis: Redis;
  /**
   * Verschiebt den laufenden Job um delayMs (BullMQ moveToDelayed + DelayedError), ohne
   * einen Attempt zu verbrauchen (Ticket #13). Die Promise löst nie auf. Nur im
   * Worker-Prozess gesetzt — in onFinalFailure fehlt der aktive Job, dann undefined.
   */
  defer?: (delayMs: number) => Promise<never>;
  /**
   * Nummer des laufenden Versuchs (1-basiert) und Max-Versuche des Jobs (Ticket #19).
   * Nur im Worker-Prozess gesetzt (process), nicht in den Fehler-Hooks — dort liefert
   * der übergebene Job diese Werte.
   */
  attempt?: number;
  maxAttempts?: number;
  /**
   * Id des laufenden Jobs, für Ereignis-Details wie details.job_id (Ticket #20). Nur im
   * Worker-Prozess gesetzt (process), nicht in den Fehler-Hooks — dort liefert der
   * übergebene Job diesen Wert.
   */
  jobId?: string;
}

export interface JobType<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** e.g. "media.extract-audio" */
  name: string;
  queue: QueueName;
  payloadSchema: P;
  /** BullMQ-Retry-Defaults, die POST /jobs an add() durchreicht. Ohne Angabe: 1 Versuch. */
  attempts?: number;
  backoff?: JobsOptions["backoff"];
  process: (payload: z.infer<P>, ctx: JobContext) => Promise<unknown>;
  /**
   * Hook auf das endgültige Scheitern (Ticket #9). Ruft der Worker im failed-Handler
   * genau einmal auf, wenn kein Retry mehr folgt (isFinalFailure). Fehler im Hook werden
   * geloggt (event: "onFinalFailure.error") und brechen nichts. Typisch: Pin auf error
   * setzen und per ctx.enqueue eine Fehler-Mail als Folge-Job einreihen.
   */
  onFinalFailure?: (payload: z.infer<P>, error: Error, ctx: JobContext, job: FailableJob) => void | Promise<void>;
  /**
   * Hook auf einen fehlgeschlagenen Versuch, dem noch ein Retry folgt (Ticket #19). Ruft
   * der Worker im failed-Handler nur bei einem Zwischenfehler auf (nicht final), analog zu
   * onFinalFailure. Fehler im Hook werden geloggt (event: "onRetryScheduled.error") und
   * dürfen den bereits eingeplanten Retry nicht verhindern. Typisch: ein retry_scheduled-
   * Ereignis schreiben.
   */
  onRetryScheduled?: (payload: z.infer<P>, error: Error, ctx: JobContext, job: FailableJob) => void | Promise<void>;
}

const registry = new Map<string, JobType>();

export function registerJobType<P extends z.ZodTypeAny>(jobType: JobType<P>): void {
  if (registry.has(jobType.name)) {
    throw new Error(`Job type already registered: ${jobType.name}`);
  }
  registry.set(jobType.name, jobType as unknown as JobType);
}

export function getJobType(name: string): JobType | undefined {
  return registry.get(name);
}

export function allJobTypes(): JobType[] {
  return [...registry.values()];
}
