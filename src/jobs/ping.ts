import { z } from "zod";
import { registerJobType } from "./registry.js";

// Smoke-test job type: proves queue -> worker -> result roundtrip end to end.
registerJobType({
  name: "integrations.ping",
  queue: "integrations",
  payloadSchema: z.object({ message: z.string().default("pong") }),
  process: async (payload) => ({ echo: payload.message, at: new Date().toISOString() }),
});
