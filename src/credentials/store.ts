import { decryptCredential, encryptCredential } from "./crypto.js";

// Zentrale Lese-Funktion (Spec): select … for update verhindert parallele Refreshes,
// der zweite Worker wartet auf den Lock und sieht das frische Token.
const REFRESH_BUFFER_MS = 60_000;

export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PROVIDERS = ["google", "shopify", "apikey"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Refresher {
  (data: Record<string, unknown>): Promise<{ data: Record<string, unknown>; expiresAt: Date }>;
}

// Strukturelles Pool-Interface: testbar ohne echtes pg.
export interface CredentialClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  release(): void;
}
export interface CredentialPool {
  connect(): Promise<CredentialClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export async function getCredential(
  pool: CredentialPool,
  masterKey: string,
  name: string,
  refreshers: Record<string, Refresher>,
  now: number = Date.now(),
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("begin");
    const result = await client.query(
      "select name, provider, data_encrypted, token_expires_at, status from credential where name = $1 for update",
      [name],
    );
    const row = result.rows[0] as
      | { name: string; provider: string; data_encrypted: Buffer; token_expires_at: Date | null; status: string }
      | undefined;
    if (!row) throw new Error(`Credential not found: ${name}`);
    if (row.status === "reauth_required") {
      throw new Error(`Credential needs reauth: ${name} — Connect-Flow erneut durchlaufen`);
    }
    const data = decryptCredential(masterKey, name, row.data_encrypted);
    const expiresAt = row.token_expires_at ? row.token_expires_at.getTime() : null;
    const refresher = refreshers[row.provider];
    if (expiresAt === null || expiresAt > now + REFRESH_BUFFER_MS || !refresher) {
      await client.query("commit");
      committed = true;
      return data;
    }
    // Token läuft bald ab — Refresh versuchen
    try {
      const refreshed = await refresher(data);
      await client.query(
        "update credential set data_encrypted = $1, token_expires_at = $2, status = $3, updated_at = now() where name = $4",
        [encryptCredential(masterKey, name, refreshed.data), refreshed.expiresAt, "ok", name],
      );
      await client.query("commit");
      committed = true;
      return refreshed.data;
    } catch (refreshErr) {
      // Refresh fehlgeschlagen → als reauth_required markieren und committen,
      // dann Fehler weiterwerfen. Der äußere catch rollback nur wenn noch offen.
      await client.query(
        "update credential set data_encrypted = $1, token_expires_at = $2, status = $3, updated_at = now() where name = $4",
        [row.data_encrypted, row.token_expires_at, "reauth_required", name],
      );
      await client.query("commit");
      committed = true;
      throw refreshErr;
    }
  } catch (err) {
    // Rollback nur wenn die TX noch offen ist (committed = false).
    // Ein Rollback nach einem Commit ist ein No-op in Postgres, aber
    // redundant und führt zu Warnings.
    if (!committed) await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Upsert nach OAuth-Callback oder Admin-Insert. Provider-Mismatch (Name existiert
// mit anderem Provider) aktualisiert nichts — Aufrufer prüft rowCount.
export async function upsertCredential(
  pool: CredentialPool,
  masterKey: string,
  opts: { name: string; provider: Provider; data: Record<string, unknown>; tokenExpiresAt: Date | null },
): Promise<boolean> {
  const result = await pool.query(
    `insert into credential (name, provider, data_encrypted, token_expires_at, status)
     values ($1, $2, $3, $4, 'ok')
     on conflict (name) do update
       set data_encrypted = excluded.data_encrypted,
           token_expires_at = excluded.token_expires_at,
           status = 'ok',
           updated_at = now()
       where credential.provider = excluded.provider`,
    [opts.name, opts.provider, encryptCredential(masterKey, opts.name, opts.data), opts.tokenExpiresAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listCredentials(
  pool: CredentialPool,
): Promise<{ name: string; provider: string; status: string; token_expires_at: Date | null }[]> {
  const result = await pool.query(
    "select name, provider, status, token_expires_at from credential order by name",
  );
  return result.rows;
}

export async function deleteCredential(pool: CredentialPool, name: string): Promise<boolean> {
  const result = await pool.query("delete from credential where name = $1", [name]);
  return (result.rowCount ?? 0) > 0;
}

// Für den Background-Refresh: Google-Credentials, die bald ablaufen.
export async function listExpiringCredentials(pool: CredentialPool, withinMs: number): Promise<string[]> {
  const result = await pool.query(
    `select name from credential
     where provider = 'google' and status = 'ok'
       and token_expires_at is not null
       and token_expires_at < now() + ($1 || ' milliseconds')::interval`,
    [String(withinMs)],
  );
  return result.rows.map((r: { name: string }) => r.name);
}
