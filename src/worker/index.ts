import { Queue, Worker } from "bullmq";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import { CLEANUP_JOB_NAME } from "../jobs/cleanup.js";
import { CREDENTIALS_REFRESH_JOB_NAME } from "../jobs/credentials-refresh.js";
import { archiveFinished } from "../archive.js";
import { sendCallback } from "../callback.js";
import { getCredential, type Refresher } from "../credentials/store.js";
import { refreshAccessToken } from "../credentials/providers/google.js";
import type { JobContext } from "../jobs/registry.js";
import "../jobs/ping.js";
import "../jobs/media.js";

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);
const db = new pg.Pool({ connectionString: config.DATABASE_URL });

// Credential-Kontext (ADR-0002): Lazy-Refresh läuft zentral hier, nie in Job-Code.
const refreshers: Record<string, Refresher> = {};
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  const clientId = config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_CLIENT_SECRET;
  refreshers.google = async (data) => {
    const result = await refreshAccessToken({ clientId, clientSecret, refreshToken: data.refreshToken as string });
    return { data: { ...data, accessToken: result.accessToken }, expiresAt: result.expiresAt };
  };
}
const ctx: JobContext = {
  db,
  getCredential: (name) => {
    if (!config.CREDENTIAL_MASTER_KEY) {
      return Promise.reject(new Error("Credential store not configured (CREDENTIAL_MASTER_KEY missing)"));
    }
    return getCredential(db, config.CREDENTIAL_MASTER_KEY, name, refreshers);
  },
};

// Repeatable Cleanup (ADR-0004) — Upsert ist idempotent.
if (config.WORKER_QUEUES.includes("media")) {
  const mediaQueue = new Queue("media", { connection });
  await mediaQueue.upsertJobScheduler(`${CLEANUP_JOB_NAME}-hourly`, { every: 3600_000 }, { name: CLEANUP_JOB_NAME });
  await mediaQueue.close();
}

// Repeatable Background-Refresh (Spec) — nur sinnvoll wenn der Store konfiguriert ist.
if (config.WORKER_QUEUES.includes("integrations") && config.CREDENTIAL_MASTER_KEY) {
  const integrationsQueue = new Queue("integrations", { connection });
  await integrationsQueue.upsertJobScheduler(
    `${CREDENTIALS_REFRESH_JOB_NAME}-30min`,
    { every: 1_800_000 },
    { name: CREDENTIALS_REFRESH_JOB_NAME },
  );
  await integrationsQueue.close();
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
        return jobType.process(payload, ctx);
      },
      { connection, concurrency: queueName === "media" ? 1 : 5 },
    ),
);

function notifyCallback(
  queue: string,
  job: { id?: string; name: string; data?: { tenant?: string | null; callbackUrl?: string | null } },
  outcome: { status: "completed"; result: unknown } | { status: "failed"; error: string },
): void {
  const url = job.data?.callbackUrl;
  if (!url || !job.id) return;
  void sendCallback(
    url,
    {
      jobId: job.id,
      queue,
      type: job.name,
      status: outcome.status,
      tenant: job.data?.tenant ?? null,
      ...(outcome.status === "completed" ? { result: outcome.result } : { error: outcome.error }),
    },
    config.URL_SIGNING_SECRET,
  ).then((r) => {
    if (!r.ok) {
      console.error(JSON.stringify({ event: "callback.failed", queue, jobId: job.id, url, status: r.status, error: r.error }));
    }
  });
}

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.log(JSON.stringify({ event: "completed", queue: worker.name, jobId: job.id, type: job.name }));
    void archiveFinished(db, worker.name, job.id!, { status: "completed", result: job.returnvalue });
    notifyCallback(worker.name, job, { status: "completed", result: job.returnvalue });
  });
  worker.on("failed", (job, err) => {
    console.error(JSON.stringify({ event: "failed", queue: worker.name, jobId: job?.id, type: job?.name, error: err.message }));
    if (job?.id) {
      void archiveFinished(db, worker.name, job.id, { status: "failed", error: err.message });
      notifyCallback(worker.name, job, { status: "failed", error: err.message });
    }
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
