import { DelayedError, Queue, Worker, type Job } from "bullmq";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import { CLEANUP_JOB_NAME } from "../jobs/cleanup.js";
import { CREDENTIALS_REFRESH_JOB_NAME } from "../jobs/credentials-refresh.js";
import { archiveFinished, archiveQueued } from "../archive.js";
import { handleFailed, type FailableJob } from "./failure.js";
import { createContextEnqueue } from "../jobs/enqueue.js";
import { sendCallback } from "../callback.js";
import { getCredential, type Refresher } from "../credentials/store.js";
import { refreshAccessToken } from "../credentials/providers/google.js";
import type { JobContext } from "../jobs/registry.js";
import "../jobs/ping.js";
import "../jobs/media.js";
import "../jobs/pinfinity/cleanup.js";
import "../jobs/pinfinity/publish-pin.js";
import "../jobs/pinfinity/send-publish-error-mail.js";
import "../jobs/pinfinity/reconcile-publish-jobs.js";
import "../jobs/pinfinity/cleanup-publish-events.js";

const config = loadConfig();
const connection = createRedis(config.REDIS_URL);
const db = new pg.Pool({ connectionString: config.DATABASE_URL });

// Credential-Kontext (ADR-0002): Lazy-Refresh läuft zentral hier, nie in Job-Code.
// Client-ID/Secret kommen pro Token aus der verknüpften App-Row (getCredential löst sie auf).
const refreshers: Record<string, Refresher> = {
  google: async (data, appCreds) => {
    const result = await refreshAccessToken({
      clientId: appCreds.clientId,
      clientSecret: appCreds.clientSecret,
      refreshToken: data.refreshToken as string,
    });
    return { data: { ...data, accessToken: result.accessToken }, expiresAt: result.expiresAt };
  },
};
const getCredentialForJob = (name: string): Promise<Record<string, unknown>> => {
  if (!config.CREDENTIAL_MASTER_KEY) {
    return Promise.reject(new Error("Credential store not configured (CREDENTIAL_MASTER_KEY missing)"));
  }
  return getCredential(db, config.CREDENTIAL_MASTER_KEY, name, refreshers);
};

// Persistente Queues für ctx.enqueue (Ticket #9): Folge-Jobs dürfen auch in Queues
// landen, die dieser Worker nicht konsumiert — dafür reicht der Redis-Zugriff.
const enqueueQueues = new Map<string, Queue>();
function enqueueQueue(name: string): Queue {
  let queue = enqueueQueues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection });
    enqueueQueues.set(name, queue);
  }
  return queue;
}

// Pro Job ein Kontext: ctx.enqueue erbt Consumer (sonst "system") und Tenant des
// Ursprungsjobs. job.data fehlt bei Scheduler-Jobs — dann greift der Fallback.
// deferrable (aktiver Job + Token) gibt es nur im Worker-Prozess, nicht in
// onFinalFailure — nur dann kann sich der Job per moveToDelayed selbst verschieben.
function jobContext(
  data: { consumer?: string; tenant?: string | null } | undefined,
  deferrable?: { job: Job; token: string | undefined },
): JobContext {
  const ctx: JobContext = {
    db,
    getCredential: getCredentialForJob,
    enqueue: createContextEnqueue({
      getQueue: (name) => enqueueQueue(name),
      archive: (entry) => archiveQueued(db, entry),
      origin: { consumer: data?.consumer ?? "system", tenant: data?.tenant ?? null },
    }),
    redis: connection,
  };
  if (deferrable) {
    ctx.defer = async (delayMs: number): Promise<never> => {
      await deferrable.job.moveToDelayed(Date.now() + delayMs, deferrable.token);
      // DelayedError signalisiert BullMQ: Job ist verschoben, kein fehlgeschlagener Versuch.
      throw new DelayedError();
    };
    // Versuchszähler für Ereignis-Logs (Ticket #19). attemptsMade ist während des Laufs
    // noch nicht hochgezählt, der laufende Versuch ist also attemptsMade + 1.
    ctx.attempt = deferrable.job.attemptsMade + 1;
    ctx.maxAttempts = deferrable.job.opts.attempts ?? 1;
    // Job-Id für Ereignis-Details (z.B. mail_sent.details.job_id, Ticket #20).
    if (deferrable.job.id) ctx.jobId = deferrable.job.id;
  }
  return ctx;
}

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
      async (job, token) => {
        const jobType = getJobType(job.name);
        if (!jobType) {
          throw new Error(`No processor registered for job type: ${job.name}`);
        }
        // job.data = { payload, consumer } — Quelle ist Job-Attribut (ADR-0003).
        // Scheduler-Jobs (Cleanup) haben kein data — leeres Payload.
        const payload = jobType.payloadSchema.parse(job.data?.payload ?? {});
        return jobType.process(payload, jobContext(job.data, { job, token }));
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

// Baut die Closure für einen der Fehler-Hooks des Job-Typs (onFinalFailure, Ticket #9,
// oder onRetryScheduled, Ticket #19) für den failed-Handler oder undefined, wenn der
// Job-Typ den Hook nicht hat. handleFailed ruft onFinalFailure nur beim letzten,
// onRetryScheduled nur bei einem Zwischenversuch auf.
function jobTypeHook(
  event: "onFinalFailure" | "onRetryScheduled",
  queue: string,
  job:
    | { id?: string; name: string; data?: { consumer?: string; tenant?: string | null; payload?: unknown } }
    | undefined,
  err: Error,
): (() => void | Promise<void>) | undefined {
  if (!job) return undefined;
  const jobType = getJobType(job.name);
  const hook = jobType?.[event];
  if (!hook) return undefined;
  const parsed = jobType.payloadSchema.safeParse(job.data?.payload ?? {});
  if (!parsed.success) {
    console.error(JSON.stringify({ event: `${event}.error`, queue, jobId: job.id, type: job.name, error: "invalid payload" }));
    return undefined;
  }
  return () => hook(parsed.data, err, jobContext(job.data), job as FailableJob);
}

for (const worker of workers) {
  worker.on("completed", (job) => {
    console.log(JSON.stringify({ event: "completed", queue: worker.name, jobId: job.id, type: job.name }));
    void archiveFinished(db, worker.name, job.id!, { status: "completed", result: job.returnvalue });
    notifyCallback(worker.name, job, { status: "completed", result: job.returnvalue });
  });
  worker.on("failed", (job, err) => {
    // Archiv und Callback erst beim endgültigen Scheitern (Ticket #8). Zwischenfehler
    // mit anstehendem Retry erzeugen nur ein retry_scheduled-Log in handleFailed.
    // onFinalFailure-Hook (Ticket #9) läuft ebenfalls nur beim letzten Versuch.
    handleFailed(job, err, {
      queue: worker.name,
      archiveFailed: (jobId, error) => void archiveFinished(db, worker.name, jobId, { status: "failed", error }),
      notifyFailed: (error) => {
        if (job) notifyCallback(worker.name, job, { status: "failed", error });
      },
      onFinalFailure: jobTypeHook("onFinalFailure", worker.name, job, err),
      onRetryScheduled: jobTypeHook("onRetryScheduled", worker.name, job, err),
    });
  });
}

console.log(JSON.stringify({ event: "worker.started", queues: config.WORKER_QUEUES }));

async function shutdown() {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all([...enqueueQueues.values()].map((q) => q.close()));
  await connection.quit();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
