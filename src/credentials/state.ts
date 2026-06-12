import { randomBytes } from "node:crypto";

// OAuth-State: 32 Byte Zufall als Redis-Key, single-use (getdel), 10 min TTL.
// Schützt die öffentlichen Callback-Routen — nur wer den Connect gestartet hat, kann abschließen.
const STATE_TTL_SECONDS = 600;

export interface StatePayload {
  name: string;
  provider: "google" | "shopify";
  scopes?: string[];
  shop?: string;
}

// Strukturelles Interface statt ioredis-Typ: hält das Modul testbar ohne echtes Redis.
export interface StateRedis {
  set(key: string, value: string, ex: "EX", ttl: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export async function createState(redis: StateRedis, payload: StatePayload): Promise<string> {
  const state = randomBytes(32).toString("hex");
  await redis.set(`oauth-state:${state}`, JSON.stringify(payload), "EX", STATE_TTL_SECONDS);
  return state;
}

export async function consumeState(redis: StateRedis, state: string): Promise<StatePayload | null> {
  const raw = await redis.getdel(`oauth-state:${state}`);
  return raw ? (JSON.parse(raw) as StatePayload) : null;
}
