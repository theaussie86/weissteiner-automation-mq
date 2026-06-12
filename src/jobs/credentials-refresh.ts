import { z } from "zod";
import { registerJobType } from "./registry.js";
import { listExpiringCredentials } from "../credentials/store.js";

// Background-Refresh (Spec): proaktiv Google-Tokens erneuern, die binnen 45 min ablaufen.
// Nutzt denselben getCredential-Pfad wie der Lazy-Refresh — eine Refresh-Implementierung.
export const CREDENTIALS_REFRESH_JOB_NAME = "credentials.refresh";
export const REFRESH_HORIZON_MS = 45 * 60_000;

registerJobType({
  name: CREDENTIALS_REFRESH_JOB_NAME,
  queue: "integrations",
  payloadSchema: z.object({}).optional().transform(() => ({})),
  process: async (_payload, ctx) => {
    const names = await listExpiringCredentials(ctx.db, REFRESH_HORIZON_MS);
    const refreshed: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const name of names) {
      try {
        await ctx.getCredential(name);
        refreshed.push(name);
      } catch (err) {
        failed.push({ name, error: (err as Error).message });
      }
    }
    if (failed.length > 0) {
      console.error(JSON.stringify({ event: "credentials.refresh.failed", failed }));
    }
    return { refreshed, failed };
  },
});
