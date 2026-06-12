import { Queue, Worker } from "bullmq";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import { CLEANUP_JOB_NAME } from "../jobs/cleanup.js";
import { archiveFinished } from "../archive.js";
import "../jobs/ping.js";
import "../jobs/media.js";

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);
const db = new pg.Pool({ connectionString: config.DATABASE_URL });

// Repeatable Cleanup (ADR-0004) — Upsert ist idempotent.
if (config.WORKER_QUEUES.includes("media")) {
  const mediaQueue = new Queue("media", { connection });
  await mediaQueue.upsertJobScheduler(`${CLEANUP_JOB_NAME}-hourly`, { every: 3600_000 }, { name: CLEANUP_JOB_NAME });
  await mediaQueue.close();
}

const workers = config.WORKER_QUEUES.map(
  (queueName) =>
    new Worker(
      queueName,
      async (job) => {
        const jobType = getJobType(job.name);
        if (!jobType) {
          throw new Error(`No processor registered for job type: ${job.name}`);
        }
        // job.data = { payload, consumer } — Quelle ist Job-Attribut (ADR-0003).
        // Scheduler-Jobs (Cleanup) haben kein data — leeres Payload.
        const payload = jobType.payloadSchema.parse(job.data?.payload ?? {});
        return jobType.process(payload);
      },
      { connection, concurrency: queueName === "media" ? 1 : 5 },
    ),
);

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.log(JSON.stringify({ event: "completed", queue: worker.name, jobId: job.id, type: job.name }));
    void archiveFinished(db, worker.name, job.id!, { status: "completed", result: job.returnvalue });
  });
  worker.on("failed", (job, err) => {
    console.error(JSON.stringify({ event: "failed", queue: worker.name, jobId: job?.id, type: job?.name, error: err.message }));
    if (job?.id) void archiveFinished(db, worker.name, job.id, { status: "failed", error: err.message });
  });
}

console.log(JSON.stringify({ event: "worker.started", queues: config.WORKER_QUEUES }));

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await connection.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
