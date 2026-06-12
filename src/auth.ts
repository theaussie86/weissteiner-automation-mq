import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Consumer {
  id: string;
  name: string;
  queueScopes: string[];
}

export function generateApiKey(): string {
  return `mq_${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function hasQueueScope(consumer: Consumer, queue: string): boolean {
  return consumer.queueScopes.includes(queue) || consumer.queueScopes.includes("*");
}

// Konstantzeit-Vergleich für den Admin-Key (App-Secret, kein Credential).
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
