import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  REDIS_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  WORKER_QUEUES: z
    .string()
    .default("media,integrations")
    .transform((s) => s.split(",").map((q) => q.trim()).filter(Boolean)),
  FILES_DIR: z.string().default("/data/files"),
  // App-Secret (CONTEXT.md): schaltet die /admin-Routen frei; ohne Wert sind sie deaktiviert.
  // Compose-Interpolation liefert "" wenn unbesetzt — leer zählt als nicht gesetzt.
  ADMIN_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  // App-Secrets für Temp-URLs: Signatur-Key (API + Worker identisch) und öffentliche Basis-URL.
  URL_SIGNING_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  PUBLIC_BASE_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  // Credential Store (ADR-0002): Master-Key entschlüsselt die credential-Tabelle.
  // 32 Byte base64; ohne Wert ist der Store deaktiviert (503 auf den Routen).
  CREDENTIAL_MASTER_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes base64")
      .optional(),
  ),
  GOOGLE_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  SHOPIFY_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  SHOPIFY_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
