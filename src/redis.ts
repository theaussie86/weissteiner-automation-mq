import { Redis } from "ioredis";

// BullMQ requires maxRetriesPerRequest: null on worker connections.
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
