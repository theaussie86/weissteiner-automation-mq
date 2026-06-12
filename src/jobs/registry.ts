import { z } from "zod";
import type pg from "pg";

export const QUEUES = ["media", "integrations"] as const;
export type QueueName = (typeof QUEUES)[number];

// Worker-seitiger Kontext: Credential-Zugriff und DB für Jobs, die mehr brauchen
// (z.B. credentials.refresh). API ruft process nie auf.
export interface JobContext {
  db: pg.Pool;
  getCredential: (name: string) => Promise<Record<string, unknown>>;
}

export interface JobType<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** e.g. "media.extract-audio" */
  name: string;
  queue: QueueName;
  payloadSchema: P;
  process: (payload: z.infer<P>, ctx: JobContext) => Promise<unknown>;
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
