import { Worker } from "bullmq";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import "../jobs/ping.js";

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);

const workers = config.WORKER_QUEUES.map(
  (queueName) =>
    new Worker(
      queueName,
      async (job) => {
        const jobType = getJobType(job.name);
        if (!jobType) {
          throw new Error(`No processor registered for job type: ${job.name}`);
        }
        // job.data = { payload, consumer } — Quelle ist Job-Attribut (ADR-0003)
        const payload = jobType.payloadSchema.parse(job.data.payload);
        return jobType.process(payload);
      },
      { connection, concurrency: queueName === "media" ? 1 : 5 },
    ),
);

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.log(JSON.stringify({ event: "completed", queue: worker.name, jobId: job.id, type: job.name }));
  });
  worker.on("failed", (job, err) => {
    console.error(JSON.stringify({ event: "failed", queue: worker.name, jobId: job?.id, type: job?.name, error: err.message }));
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
