import { z } from "zod";
import { registerJobType } from "./registry.js";
import { createVolumeStorage } from "../storage/index.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const storage = createVolumeStorage(config.FILES_DIR);

// Repeatable Job (ADR-0004): räumt abgelaufene Ergebnis-Dateien vom Shared Volume.
// Wird vom Worker beim Start als stündlicher Repeatable upserted.
export const CLEANUP_JOB_NAME = "media.cleanup-files";
export const FILE_TTL_MS = 24 * 3600 * 1000; // muss >= Temp-URL-TTL sein

registerJobType({
  name: CLEANUP_JOB_NAME,
  queue: "media",
  payloadSchema: z.object({}).optional().transform(() => ({})),
  process: async () => {
    const removed = await storage.purgeOlderThan(FILE_TTL_MS);
    return { removed };
  },
});
