import Fastify from "fastify";
import { Queue } from "bullmq";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { loadConfig } from "../config.js";
import { createRedis } from "../redis.js";
import { QUEUES } from "../jobs/registry.js";

// Bull Board läuft als eigener Service ohne öffentliche Domain.
// Production: Port nur auf 127.0.0.1 des Hosts gebunden — Zugriff via SSH-Tunnel.
const config = loadConfig();
const redis = createRedis(config.REDIS_URL);

const serverAdapter = new FastifyAdapter();
createBullBoard({
  queues: QUEUES.map((name) => new BullMQAdapter(new Queue(name, { connection: redis }))),
  serverAdapter,
});

const app = Fastify({ logger: true });
await app.register(serverAdapter.registerPlugin(), { prefix: "/" });
await app.listen({ port: config.PORT, host: "0.0.0.0" });
