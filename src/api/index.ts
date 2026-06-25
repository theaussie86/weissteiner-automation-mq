import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Queue } from "bullmq";
import pg from "pg";
import { runner as runMigrations } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { getJobType } from "../jobs/registry.js";
import { generateApiKey, hashApiKey, hasQueueScope, safeEqual, type Consumer } from "../auth.js";
import { archiveQueued } from "../archive.js";
import { createVolumeStorage } from "../storage/index.js";
import { verifyTempUrl } from "../storage/temp-url.js";
import {
  CREDENTIAL_NAME_PATTERN,
  deleteCredential,
  deleteOAuthApp,
  listCredentials,
  listOAuthApps,
  upsertCredential,
  upsertOAuthApp,
} from "../credentials/store.js";
import { consumeState, createState } from "../credentials/state.js";
import * as google from "../credentials/providers/google.js";
import * as shopify from "../credentials/providers/shopify.js";
import "../jobs/ping.js";
import "../jobs/media.js";
import "../jobs/cleanup.js";
import "../jobs/credentials-refresh.js";

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

// Admin-Guard (App-Secret, CONTEXT.md): true = durchgelassen, sonst ist die Reply schon gesendet.
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminKey = request.headers["x-admin-key"];
  if (!config.ADMIN_KEY) {
    void reply.code(503).send({ error: "Admin API not configured" });
    return false;
  }
  if (typeof adminKey !== "string" || !safeEqual(adminKey, config.ADMIN_KEY)) {
    void reply.code(401).send({ error: "Invalid admin key" });
    return false;
  }
  return true;
}

app.addHook("onRequest", async (request, reply) => {
  // /files: HMAC-Signatur (Temp-URL). /credentials/callback: OAuth-State (single-use, Redis).
  if (
    request.url === "/health" ||
    request.url.startsWith("/admin/") ||
    request.url.startsWith("/files/") ||
    request.url.startsWith("/credentials/callback/")
  )
    return;
  const auth = request.headers.authorization;
  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  const consumer = key ? await findConsumerByKey(key) : null;
  if (!consumer) {
    return reply.code(401).send({ error: "Missing or invalid API key" });
  }
  request.consumer = consumer;
});

app.get("/health", async (_request, reply) => {
  const [redisOk, dbOk] = await Promise.all([
    redis.ping().then(() => true, () => false),
    db.query("select 1").then(() => true, () => false),
  ]);
  const healthy = redisOk && dbOk;
  return reply
    .code(healthy ? 200 : 503)
    .send({ status: healthy ? "ok" : "degraded", redis: redisOk, postgres: dbOk });
});

app.post<{ Body: { name: string; queueScopes: string[] } }>(
  "/admin/consumers",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
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

const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

app.post<{ Body: { type: string; payload?: unknown; tenant?: string; callbackUrl?: string } }>("/jobs", async (request, reply) => {
  const { type, payload, tenant, callbackUrl } = request.body ?? {};
  const jobType = type ? getJobType(type) : undefined;
  if (!jobType) {
    return reply.code(400).send({ error: `Unknown job type: ${type}` });
  }
  if (!hasQueueScope(request.consumer!, jobType.queue)) {
    return reply.code(403).send({ error: `No scope for queue: ${jobType.queue}` });
  }
  if (tenant !== undefined && !TENANT_PATTERN.test(tenant)) {
    return reply.code(422).send({ error: "Invalid tenant: lowercase letters, digits, hyphens, max 64 chars" });
  }
  if (callbackUrl !== undefined && !/^https?:\/\//.test(callbackUrl)) {
    return reply.code(422).send({ error: "Invalid callbackUrl: must be http(s) URL" });
  }
  const parsed = jobType.payloadSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return reply.code(422).send({ error: "Invalid payload", issues: parsed.error.issues });
  }
  const job = await getQueue(jobType.queue).add(jobType.name, {
    payload: parsed.data,
    consumer: request.consumer!.name,
    tenant: tenant ?? null,
    callbackUrl: callbackUrl ?? null,
  });
  await archiveQueued(db, {
    jobId: job.id!,
    queue: jobType.queue,
    type: jobType.name,
    consumer: request.consumer!.name,
    tenant,
    payload: parsed.data,
  });
  return reply.code(202).send({ jobId: job.id, queue: jobType.queue, type: jobType.name, tenant: tenant ?? null });
});

// Job-Archiv-Abfrage hinter ADMIN_KEY: Filter nach Mandant, Consumer, Typ, Status (ADR-0007).
app.get<{
  Querystring: { tenant?: string; consumer?: string; type?: string; status?: string; limit?: string };
}>("/admin/jobs", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const filters: string[] = [];
  const params: unknown[] = [];
  for (const field of ["tenant", "consumer", "type", "status"] as const) {
    const value = request.query[field];
    if (value) {
      params.push(value);
      filters.push(`${field} = $${params.length}`);
    }
  }
  params.push(Math.min(Number(request.query.limit) || 50, 500));
  const where = filters.length ? `where ${filters.join(" and ")}` : "";
  const result = await db.query(
    `select job_id, queue, type, consumer, tenant, status, result, error, created_at, finished_at
     from job_archive ${where}
     order by created_at desc
     limit $${params.length}`,
    params,
  );
  return { jobs: result.rows, count: result.rowCount };
});

// Credential Store (ADR-0002): nur apikey wird direkt angelegt, OAuth läuft über Connect-Flow.
app.post<{ Body: { name: string; provider: string; data: Record<string, unknown> } }>(
  "/admin/credentials",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!config.CREDENTIAL_MASTER_KEY) return reply.code(503).send({ error: "Credential store not configured" });
    const { name, provider, data } = request.body ?? {};
    if (provider !== "apikey") {
      return reply.code(422).send({ error: "Only provider 'apikey' can be created directly — use the connect flow" });
    }
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length === 0) {
      return reply.code(422).send({ error: "data must be a non-empty object" });
    }
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name,
      provider: "apikey",
      data,
      tokenExpiresAt: null,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${name}` });
    // Nie Klartext in der Response (Spec).
    return reply.code(201).send({ name, provider: "apikey" });
  },
);

app.get("/admin/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const credentials = await listCredentials(db);
  return { credentials, count: credentials.length };
});

app.delete<{ Params: { name: string } }>("/admin/credentials/:name", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const removed = await deleteCredential(db, request.params.name);
  if (!removed) return reply.code(404).send({ error: "Credential not found" });
  return reply.code(204).send();
});

// OAuth-App-Verwaltung: Client-ID/Secret verschlüsselt im Store, mehrere Apps pro Provider.
app.post<{ Body: { name: string; provider: string; clientId: string; clientSecret: string } }>(
  "/admin/credentials/oauth-app",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!config.CREDENTIAL_MASTER_KEY) return reply.code(503).send({ error: "Credential store not configured" });
    const { name, provider, clientId, clientSecret } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (provider !== "google" && provider !== "shopify") {
      return reply.code(422).send({ error: "provider must be 'google' or 'shopify'" });
    }
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
      return reply.code(422).send({ error: "clientId and clientSecret required" });
    }
    const ok = await upsertOAuthApp(db, config.CREDENTIAL_MASTER_KEY, { name, provider, clientId, clientSecret });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${name}` });
    return reply.code(201).send({ name, provider: `${provider}-app` });
  },
);

app.get("/admin/credentials/oauth-app", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const apps = await listOAuthApps(db);
  return { apps, count: apps.length };
});

app.delete<{ Params: { name: string } }>("/admin/credentials/oauth-app/:name", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const removed = await deleteOAuthApp(db, request.params.name);
  if (!removed) return reply.code(404).send({ error: "OAuth app not found" });
  return reply.code(204).send();
});

// OAuth-Connect (Spec): Admin startet, bekommt authUrl, klickt Consent selbst durch.
// State liegt single-use in Redis; der Callback ist öffentlich, aber nur mit State nutzbar.
function oauthRedirectUri(provider: "google" | "shopify"): string | null {
  return config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}/credentials/callback/${provider}` : null;
}

app.post<{ Body: { name: string; scopes: string[] } }>(
  "/admin/credentials/google/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Google OAuth not configured" });
    }
    const { name, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    const state = await createState(redis, { name, provider: "google", scopes });
    const authUrl = google.buildAuthUrl({ clientId: config.GOOGLE_CLIENT_ID, redirectUri, scopes, state });
    return { authUrl };
  },
);

app.post<{ Body: { name: string; shop: string; scopes: string[] } }>(
  "/admin/credentials/shopify/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("shopify");
    if (!config.CREDENTIAL_MASTER_KEY || !config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Shopify OAuth not configured" });
    }
    const { name, shop, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof shop !== "string" || !shopify.SHOP_PATTERN.test(shop)) {
      return reply.code(422).send({ error: "Invalid shop: expected <shop>.myshopify.com" });
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    const state = await createState(redis, { name, provider: "shopify", shop });
    const authUrl = shopify.buildAuthUrl({ clientId: config.SHOPIFY_CLIENT_ID, shop, scopes, redirectUri, state });
    return { authUrl };
  },
);

app.get<{ Querystring: { code?: string; state?: string } }>(
  "/credentials/callback/google",
  async (request, reply) => {
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Google OAuth not configured" });
    }
    const { code, state } = request.query;
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "google") {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    const tokens = await google.exchangeCode({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "google",
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scopes: tokens.scopes },
      tokenExpiresAt: tokens.expiresAt,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (google) verbunden. Fenster kann geschlossen werden.`);
  },
);

app.get<{ Querystring: Record<string, string | undefined> }>(
  "/credentials/callback/shopify",
  async (request, reply) => {
    if (!config.CREDENTIAL_MASTER_KEY || !config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
      return reply.code(503).send({ error: "Shopify OAuth not configured" });
    }
    const { code, state, shop } = request.query;
    if (!shopify.verifyCallbackHmac(request.query, config.SHOPIFY_CLIENT_SECRET)) {
      return reply.code(403).send({ error: "Invalid HMAC" });
    }
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "shopify" || payload.shop !== shop) {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    const tokens = await shopify.exchangeCode({
      shop: payload.shop!,
      clientId: config.SHOPIFY_CLIENT_ID,
      clientSecret: config.SHOPIFY_CLIENT_SECRET,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "shopify",
      data: { shop: tokens.shop, accessToken: tokens.accessToken },
      tokenExpiresAt: null,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (shopify) verbunden. Fenster kann geschlossen werden.`);
  },
);

const storage = createVolumeStorage(config.FILES_DIR);
const CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  jpg: "image/jpeg",
  png: "image/png",
};

app.get<{ Params: { key: string }; Querystring: { exp?: string; sig?: string } }>(
  "/files/:key",
  async (request, reply) => {
    if (!config.URL_SIGNING_SECRET) return reply.code(503).send({ error: "File delivery not configured" });
    const { key } = request.params;
    const exp = Number(request.query.exp);
    const sig = request.query.sig ?? "";
    if (!exp || !sig) return reply.code(400).send({ error: "Missing exp/sig" });
    const verdict = verifyTempUrl({ secret: config.URL_SIGNING_SECRET, fileKey: key, exp, sig });
    if (!verdict.valid) {
      return reply.code(verdict.reason === "expired" ? 410 : 403).send({ error: `Temp URL ${verdict.reason}` });
    }
    try {
      const data = await storage.read(key);
      const ext = key.split(".").pop() ?? "";
      return reply.header("content-type", CONTENT_TYPES[ext] ?? "application/octet-stream").send(data);
    } catch {
      return reply.code(404).send({ error: "File not found or already cleaned up" });
    }
  },
);

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
