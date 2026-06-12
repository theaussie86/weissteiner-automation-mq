import Fastify from "fastify";
import { Queue } from "bullmq";
import pg from "pg";
import { runner as runMigrations } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import { generateApiKey, hashApiKey, hasQueueScope, safeEqual, type Consumer } from "../auth.js";
import "../jobs/ping.js";

const config = loadConfig();
const redis = createRedis(config.REDIS_URL);
const db = new pg.Pool({ connectionString: config.DATABASE_URL });
const queues = new Map<string, Queue>();

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
await runMigrations({
  databaseUrl: config.DATABASE_URL,
  dir: migrationsDir,
  direction: "up",
  migrationsTable: "pgmigrations",
  log: (msg) => console.log(`[migrate] ${msg}`),
});

function getQueue(name: string): Queue {
  let queue = queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redis });
    queues.set(name, queue);
  }
  return queue;
}

async function findConsumerByKey(key: string): Promise<Consumer | null> {
  const result = await db.query<{ id: string; name: string; queue_scopes: string[] }>(
    "select id, name, queue_scopes from consumer where key_hash = $1 and active",
    [hashApiKey(key)],
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, queueScopes: row.queue_scopes } : null;
}

const app = Fastify({ logger: true });

declare module "fastify" {
  interface FastifyRequest {
    consumer?: Consumer;
  }
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url === "/health" || request.url.startsWith("/admin/")) return;
  const auth = request.headers.authorization;
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const consumer = key ? await findConsumerByKey(key) : null;
  if (!consumer) {
    return reply.code(401).send({ error: "Missing or invalid API key" });
  }
  request.consumer = consumer;
});

app.get("/health", async () => {
  const [redisOk, dbOk] = await Promise.all([
    redis.ping().then(() => true, () => false),
    db.query("select 1").then(() => true, () => false),
  ]);
  const healthy = redisOk && dbOk;
  return { status: healthy ? "ok" : "degraded", redis: redisOk, postgres: dbOk };
});

app.post<{ Body: { name: string; queueScopes: string[] } }>(
  "/admin/consumers",
  async (request, reply) => {
    const adminKey = request.headers["x-admin-key"];
    if (!config.ADMIN_KEY) return reply.code(503).send({ error: "Admin API not configured" });
    if (typeof adminKey !== "string" || !safeEqual(adminKey, config.ADMIN_KEY)) {
      return reply.code(401).send({ error: "Invalid admin key" });
    }
    const { name, queueScopes } = request.body ?? {};
    if (!name || !Array.isArray(queueScopes) || queueScopes.length === 0) {
      return reply.code(400).send({ error: "name and queueScopes[] required" });
    }
    const key = generateApiKey();
    try {
      const result = await db.query<{ id: string }>(
        "insert into consumer (name, key_hash, queue_scopes) values ($1, $2, $3) returning id",
        [name, hashApiKey(key), queueScopes],
      );
      // Klartext-Key nur in dieser Response — gespeichert wird ausschließlich der Hash.
      return reply.code(201).send({ id: result.rows[0]?.id, name, queueScopes, apiKey: key });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: `Consumer already exists: ${name}` });
      }
      throw err;
    }
  },
);

app.post<{ Body: { type: string; payload?: unknown } }>("/jobs", async (request, reply) => {
  const { type, payload } = request.body ?? {};
  const jobType = type ? getJobType(type) : undefined;
  if (!jobType) {
    return reply.code(400).send({ error: `Unknown job type: ${type}` });
  }
  if (!hasQueueScope(request.consumer!, jobType.queue)) {
    return reply.code(403).send({ error: `No scope for queue: ${jobType.queue}` });
  }
  const parsed = jobType.payloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return reply.code(422).send({ error: "Invalid payload", issues: parsed.error.issues });
  }
  const job = await getQueue(jobType.queue).add(jobType.name, {
    payload: parsed.data,
    consumer: request.consumer!.name,
  });
  return reply.code(202).send({ jobId: job.id, queue: jobType.queue, type: jobType.name });
});

app.get<{ Params: { queue: string; id: string } }>("/jobs/:queue/:id", async (request, reply) => {
  if (!hasQueueScope(request.consumer!, request.params.queue)) {
    return reply.code(403).send({ error: `No scope for queue: ${request.params.queue}` });
  }
  const job = await getQueue(request.params.queue).getJob(request.params.id);
  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }
  const state = await job.getState();
  return { id: job.id, name: job.name, state, returnvalue: job.returnvalue ?? null };
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
