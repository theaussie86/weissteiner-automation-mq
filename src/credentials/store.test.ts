import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./crypto.js";
import { deleteOAuthApp, getOAuthApp, listOAuthApps, upsertOAuthApp, getCredential, type AppCreds, type CredentialPool, type Refresher } from "./store.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const NOW = 1_750_000_000_000;

interface Row {
  name: string;
  provider: string;
  data_encrypted: Buffer;
  token_expires_at: Date | null;
  status: string;
  parent_credential_id?: string | null;
}

// Fake-Pool: ein Client, der select/update/begin/commit gegen eine In-Memory-Zeile fährt.
function fakePool(row: Row | null) {
  const log: string[] = [];
  const state = { row };
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(sql.trim().split(/\s+/, 2).join(" ").toLowerCase());
      if (/^select/i.test(sql)) {
        return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
      }
      if (/^update/i.test(sql) && state.row) {
        // params: [data_encrypted, token_expires_at, status, name]
        state.row.data_encrypted = params![0] as Buffer;
        state.row.token_expires_at = params![1] as Date | null;
        state.row.status = params![2] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => log.push("release"),
  };
  const pool = { connect: async () => client } as unknown as CredentialPool;
  return { pool, log, state };
}

// Fake-Pool, der Token-Row (for update) UND App-Row (by id) bedient.
function fakePoolWithApp(tokenRow: Row & { parent_credential_id: string | null }, appRow: { id: string; name: string; data_encrypted: Buffer } | null) {
  const log: string[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(sql.trim().split(/\s+/, 2).join(" ").toLowerCase());
      if (/where id = \$1/i.test(sql)) {
        return { rows: appRow ? [appRow] : [], rowCount: appRow ? 1 : 0 };
      }
      if (/^select/i.test(sql)) {
        return { rows: [tokenRow], rowCount: 1 };
      }
      if (/^update/i.test(sql)) {
        if (/status\s*=\s*'reauth_required'/.test(sql) && params!.length === 1) {
          // Status-only update (no-app path): kein data_encrypted in params
          tokenRow.status = "reauth_required";
        } else {
          tokenRow.data_encrypted = params![0] as Buffer;
          tokenRow.status = (params!.length >= 3 ? params![2] : tokenRow.status) as string;
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => log.push("release"),
  };
  return { pool: { connect: async () => client } as unknown as CredentialPool, log };
}

function googleRow(expiresAt: Date | null, status = "ok"): Row {
  return {
    name: "google-wm",
    provider: "google",
    data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }),
    token_expires_at: expiresAt,
    status,
  };
}

const appData = encryptCredential(masterKey, "google-app-1", { client_id: "cid", client_secret: "csec" });
const appRow = { id: "app-uuid", name: "google-app-1", data_encrypted: appData };

const refreshers: Record<string, Refresher> = {
  google: async (data, _appCreds) => ({
    data: { ...data, accessToken: "fresh" },
    expiresAt: new Date(NOW + 3600_000),
  }),
};

describe("getCredential", () => {
  it("returns decrypted data without refresh when token is fresh", async () => {
    const { pool, log } = fakePool(googleRow(new Date(NOW + 3600_000)));
    const data = await getCredential(pool, masterKey, "google-wm", refreshers, NOW);
    expect(data.accessToken).toBe("old");
    expect(log.some((q) => q.startsWith("update"))).toBe(false);
    expect(log).toContain("commit");
    expect(log).toContain("release");
  });

  it("returns data without refresh when token_expires_at is null (apikey/shopify)", async () => {
    const { pool, log } = fakePool(googleRow(null));
    const data = await getCredential(pool, masterKey, "google-wm", refreshers, NOW);
    expect(data.accessToken).toBe("old");
    expect(log.some((q) => q.startsWith("update"))).toBe(false);
  });

  it("refreshes expiring token, persists and returns fresh data", async () => {
    const tokenRow = { ...googleRow(new Date(NOW + 30_000)), parent_credential_id: "app-uuid" };
    const { pool } = fakePoolWithApp(tokenRow, appRow);
    const data = await getCredential(pool, masterKey, "google-wm", refreshers, NOW);
    expect(data.accessToken).toBe("fresh");
  });

  it("marks credential reauth_required when refresh fails", async () => {
    const failing: Record<string, Refresher> = {
      google: async () => {
        throw new Error("invalid_grant");
      },
    };
    const tokenRow = { ...googleRow(new Date(NOW - 1000)), parent_credential_id: "app-uuid" };
    const { pool } = fakePoolWithApp(tokenRow, appRow);
    await expect(getCredential(pool, masterKey, "google-wm", failing, NOW)).rejects.toThrow(/invalid_grant/);
    expect(tokenRow.status).toBe("reauth_required");
  });

  it("rejects immediately when status is reauth_required", async () => {
    const { pool, log } = fakePool(googleRow(new Date(NOW - 1000), "reauth_required"));
    await expect(getCredential(pool, masterKey, "google-wm", refreshers, NOW)).rejects.toThrow(/reauth/i);
    expect(log.some((q) => q.startsWith("update"))).toBe(false);
  });

  it("throws for unknown credential", async () => {
    const { pool } = fakePool(null);
    await expect(getCredential(pool, masterKey, "nope", refreshers, NOW)).rejects.toThrow(/not found/i);
  });

  it("refreshes an expiring token using parent app credentials", async () => {
    const appData = encryptCredential(masterKey, "google-app-1", { client_id: "cid", client_secret: "csec" });
    const tokenRow = { name: "google-wm", provider: "google", data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }), token_expires_at: new Date(NOW + 1000), status: "ok", parent_credential_id: "app-uuid" };
    const { pool } = fakePoolWithApp(tokenRow, { id: "app-uuid", name: "google-app-1", data_encrypted: appData });
    let seenCreds: AppCreds | null = null;
    const refreshers2: Record<string, Refresher> = {
      google: async (data, appCreds) => { seenCreds = appCreds; return { data: { ...data, accessToken: "fresh" }, expiresAt: new Date(NOW + 3600_000) }; },
    };
    const data = await getCredential(pool, masterKey, "google-wm", refreshers2, NOW);
    expect(data.accessToken).toBe("fresh");
    expect(seenCreds).toEqual({ clientId: "cid", clientSecret: "csec" });
  });

  it("sets reauth_required when an expiring token has no resolvable app", async () => {
    const tokenRow = { name: "google-wm", provider: "google", data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }), token_expires_at: new Date(NOW + 1000), status: "ok", parent_credential_id: null };
    const { pool } = fakePoolWithApp(tokenRow, null);
    const refreshers3: Record<string, Refresher> = { google: async (d, _a) => ({ data: d, expiresAt: new Date(NOW) }) };
    await expect(getCredential(pool, masterKey, "google-wm", refreshers3, NOW)).rejects.toThrow(/reauth/i);
    expect(tokenRow.status).toBe("reauth_required");
  });
});

// Fake-Pool für pool.query (ohne connect) — hält eine Row-Liste in-memory.
function fakeQueryPool(rows: any[] = []) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/^insert/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/^delete/i.test(sql)) return { rows: [], rowCount: rows.length };
      if (/^select/i.test(sql)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as CredentialPool;
  return { pool, calls };
}

describe("oauth app store", () => {
  it("upsertOAuthApp encrypts client secret under -app provider", async () => {
    const { pool, calls } = fakeQueryPool();
    await upsertOAuthApp(pool, masterKey, { name: "wa-main", provider: "google", clientId: "cid", clientSecret: "csec" });
    const insert = calls.find((c) => /^insert/i.test(c.sql))!;
    expect(insert.params![1]).toBe("google-app");
    const blob = insert.params![2] as Buffer;
    expect(decryptCredential(masterKey, "wa-main", blob)).toEqual({ client_id: "cid", client_secret: "csec" });
  });

  it("getOAuthApp decrypts and returns id + base provider", async () => {
    const blob = encryptCredential(masterKey, "wa-main", { client_id: "cid", client_secret: "csec" });
    const { pool } = fakeQueryPool([{ id: "u1", provider: "google-app", data_encrypted: blob }]);
    const app = await getOAuthApp(pool, masterKey, "wa-main");
    expect(app).toEqual({ id: "u1", provider: "google", clientId: "cid", clientSecret: "csec" });
  });

  it("getOAuthApp rejects a non-app credential", async () => {
    const { pool } = fakeQueryPool([{ id: "u1", provider: "google", data_encrypted: Buffer.alloc(0) }]);
    await expect(getOAuthApp(pool, masterKey, "wa-main")).rejects.toThrow(/not an OAuth app/i);
  });

  it("listOAuthApps selects only app providers without secrets", async () => {
    const { pool, calls } = fakeQueryPool([{ name: "wa-main", provider: "google-app" }]);
    const list = await listOAuthApps(pool);
    expect(list).toEqual([{ name: "wa-main", provider: "google-app" }]);
    expect(calls[0].sql).toMatch(/provider in \('google-app','shopify-app'\)/i);
    expect(calls[0].sql).not.toMatch(/data_encrypted/i);
  });
});
