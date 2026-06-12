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
  ADMIN_KEY: z.string().min(16).optional(),
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
