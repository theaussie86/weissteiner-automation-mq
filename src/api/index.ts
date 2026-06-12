import Fastify from "fastify";
import { Queue } from "bullmq";
import pg from "pg";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import "../jobs/ping.js";

const config = loadConfig();
const redis = createRedis(config.REDIS_URL);
const db = new pg.Pool({ connectionString: config.DATABASE_URL });
const queues = new Map<string, Queue>();

function getQueue(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redis });
    queues.set(name, queue);
  }
  return queue;
}

const app = Fastify({ logger: true });

app.get("/health", async () => {
  const [redisOk, dbOk] = await Promise.all([
    redis.ping().then(() => true, () => false),
    db.query("select 1").then(() => true, () => false),
  ]);
  const healthy = redisOk && dbOk;
  return { status: healthy ? "ok" : "degraded", redis: redisOk, postgres: dbOk };
});

app.post<{ Body: { type: string; payload?: unknown } }>("/jobs", async (request, reply) => {
  const { type, payload } = request.body ?? {};
  const jobType = type ? getJobType(type) : undefined;
  if (!jobType) {
    return reply.code(400).send({ error: `Unknown job type: ${type}` });
  }
  const parsed = jobType.payloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return reply.code(422).send({ error: "Invalid payload", issues: parsed.error.issues });
  }
  const job = await getQueue(jobType.queue).add(jobType.name, parsed.data);
  return reply.code(202).send({ jobId: job.id, queue: jobType.queue, type: jobType.name });
});

app.get<{ Params: { queue: string; id: string } }>("/jobs/:queue/:id", async (request, reply) => {
  const job = await getQueue(request.params.queue).getJob(request.params.id);
  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }
  const state = await job.getState();
  return { id: job.id, name: job.name, state, returnvalue: job.returnvalue ?? null };
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
