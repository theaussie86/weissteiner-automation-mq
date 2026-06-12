import { z } from "zod";

export const QUEUES = ["media", "integrations"] as const;
export type QueueName = (typeof QUEUES)[number];

export interface JobType<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** e.g. "media.extract-audio" */
  name: string;
  queue: QueueName;
  payloadSchema: P;
  process: (payload: z.infer<P>) => Promise<unknown>;
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
