// Pinfinity-Token-Refresh: löst die Edge Function refresh-pinterest-tokens (pg_cron) ab.
// Erneuert Pinterest-Tokens, die binnen 7 Tagen ablaufen. Die Tokens bleiben in Pinfinitys
// Supabase Vault (ADR-0009, ADR-0011); der Job liest/schreibt sie per RPC über das
// service-role-Credential. Client-ID/Secret der Pinterest-App kommen aus einer apikey-Credential.
// Die Orchestrierung ist rein und gegen den RefreshClient-Seam testbar.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";
import { PinterestApiError, refreshPinterestToken } from "../../integrations/pinterest.js";

export const REFRESH_HORIZON_DAYS = 7;

export interface ExpiringConnection {
  id: string;
}

export type StepResult = { error: string | null };

export interface RefreshClient {
  listExpiringConnections(withinDays: number): Promise<ExpiringConnection[]>;
  getRefreshToken(connectionId: string): Promise<string>;
  storeTokens(connectionId: string, accessToken: string, refreshToken: string): Promise<StepResult>;
  markRefreshed(connectionId: string, expiresAt: Date): Promise<StepResult>;
  /** Persistenter Fehler: Connection deaktivieren und last_error setzen. */
  deactivate(connectionId: string, error: string): Promise<StepResult>;
  /** Transienter Fehler: Connection bleibt aktiv, nur last_error setzen. */
  recordError(connectionId: string, error: string): Promise<StepResult>;
}

export type TokenRefresher = (refreshToken: string) => ReturnType<typeof refreshPinterestToken>;

export interface RefreshDetail {
  connection_id: string;
  success: boolean;
  error?: string;
}

export interface RefreshResult {
  total: number;
  refreshed: number;
  failed: number;
  dryRun: boolean;
  details: RefreshDetail[];
}

// 4xx von Pinterest (z.B. invalid_grant) heilt kein Retry: Connection deaktivieren, damit der
// Nutzer neu verbindet. 5xx, 429 und Netzwerkfehler sind transient: beim nächsten Lauf erneut.
function isPersistent(err: unknown): boolean {
  return err instanceof PinterestApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

export async function refreshPinterestTokens(
  client: RefreshClient,
  refresher: TokenRefresher,
  opts: { dryRun: boolean },
): Promise<RefreshResult> {
  const connections = await client.listExpiringConnections(REFRESH_HORIZON_DAYS);
  const total = connections.length;
  if (opts.dryRun || total === 0) return { total, refreshed: 0, failed: 0, dryRun: opts.dryRun, details: [] };

  const details: RefreshDetail[] = [];
  for (const { id } of connections) {
    try {
      const refreshToken = await client.getRefreshToken(id);
      const tokens = await refresher(refreshToken);
      const stored = await client.storeTokens(id, tokens.accessToken, tokens.refreshToken);
      if (stored.error) throw new Error(`Failed to store new tokens: ${stored.error}`);
      const marked = await client.markRefreshed(id, tokens.expiresAt);
      if (marked.error) throw new Error(`Failed to update connection: ${marked.error}`);
      details.push({ connection_id: id, success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text = `Token refresh failed: ${message}`;
      // Fehler beim Fehler-Schreiben darf die übrigen Connections nicht blockieren.
      await (isPersistent(err) ? client.deactivate(id, text) : client.recordError(id, text)).catch(() => undefined);
      details.push({ connection_id: id, success: false, error: message });
    }
  }
  const refreshed = details.filter((d) => d.success).length;
  return { total, refreshed, failed: details.length - refreshed, dryRun: false, details };
}

// Adapter auf supabase-js. Dünn gehalten, über das Live-E2E verifiziert.
export function supabaseRefreshClient(sb: SupabaseClient): RefreshClient {
  const update = async (id: string, patch: Record<string, unknown>): Promise<StepResult> => {
    const { error } = await sb.from("pinterest_connections").update(patch).eq("id", id);
    return { error: error ? error.message : null };
  };
  return {
    async listExpiringConnections(withinDays) {
      const cutoff = new Date(Date.now() + withinDays * 24 * 3600 * 1000).toISOString();
      const { data, error } = await sb
        .from("pinterest_connections")
        .select("id")
        .eq("is_active", true)
        .lt("token_expires_at", cutoff);
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      return (data ?? []) as ExpiringConnection[];
    },
    async getRefreshToken(connectionId) {
      const { data, error } = await sb.rpc("get_pinterest_refresh_token", { p_connection_id: connectionId });
      if (error || !data) throw new Error(`Failed to retrieve refresh token: ${error?.message ?? "Unknown error"}`);
      return data as string;
    },
    async storeTokens(connectionId, accessToken, refreshToken) {
      const { error } = await sb.rpc("store_pinterest_tokens", {
        p_connection_id: connectionId,
        p_access_token: accessToken,
        p_refresh_token: refreshToken,
      });
      return { error: error ? error.message : null };
    },
    markRefreshed: (id, expiresAt) => update(id, { token_expires_at: expiresAt.toISOString(), last_error: null }),
    deactivate: (id, error) => update(id, { is_active: false, last_error: error }),
    recordError: (id, error) => update(id, { last_error: error }),
  };
}

// Form der Pinterest-App-Credential (Provider apikey, ADR-0011).
const pinterestAppSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  pinterestAppCredential: z.string().min(1),
  dryRun: z.boolean().default(false),
});

registerJobType({
  name: "pinfinity.refresh-pinterest-tokens",
  queue: "integrations",
  payloadSchema,
  process: async (payload, ctx) => {
    const sb = createSupabaseClient(await ctx.getCredential(payload.supabaseCredential));
    const app = pinterestAppSchema.parse(await ctx.getCredential(payload.pinterestAppCredential));
    return refreshPinterestTokens(supabaseRefreshClient(sb), (rt) => refreshPinterestToken(app, rt), {
      dryRun: payload.dryRun,
    });
  },
});
