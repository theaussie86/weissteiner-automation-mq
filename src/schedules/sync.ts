import type { Queue } from "bullmq";
import type { ScheduleRecord } from "./store.js";

// Nur die zwei Queue-Methoden, die der Sync braucht — erleichtert das Testen mit Fakes.
export type SchedulerQueue = Pick<Queue, "upsertJobScheduler" | "removeJobScheduler">;

// Übersetzt einen Schedule-Record in einen BullMQ-Job-Scheduler. Die job.data-Form
// (payload, consumer, tenant, callbackUrl) ist identisch zum POST /jobs-Pfad, damit der
// bestehende Worker den gescheduelten Job unverändert verarbeitet, archiviert und Callbacks sendet.
export async function upsertScheduler(queue: SchedulerQueue, s: ScheduleRecord): Promise<void> {
  await queue.upsertJobScheduler(
    s.name,
    { pattern: s.cron, tz: s.tz },
    { name: s.jobType, data: { payload: s.payload, consumer: s.consumer, tenant: null, callbackUrl: null } },
  );
}

export async function removeScheduler(queue: SchedulerQueue, name: string): Promise<boolean> {
  return queue.removeJobScheduler(name);
}
