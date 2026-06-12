import { describe, expect, it } from "vitest";
import { encryptCredential } from "./crypto.js";
import { getCredential, type CredentialPool, type Refresher } from "./store.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const NOW = 1_750_000_000_000;

interface Row {
  name: string;
  provider: string;
  data_encrypted: Buffer;
  token_expires_at: Date | null;
  status: string;
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

function googleRow(expiresAt: Date | null, status = "ok"): Row {
  return {
    name: "google-wm",
    provider: "google",
    data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }),
    token_expires_at: expiresAt,
    status,
  };
}

const refreshers: Record<string, Refresher> = {
  google: async (data) => ({
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
    const { pool, state } = fakePool(googleRow(new Date(NOW + 30_000)));
    const data = await getCredential(pool, masterKey, "google-wm", refreshers, NOW);
    expect(data.accessToken).toBe("fresh");
    expect(state.row!.token_expires_at).toEqual(new Date(NOW + 3600_000));
  });

  it("marks credential reauth_required when refresh fails", async () => {
    const failing: Record<string, Refresher> = {
      google: async () => {
        throw new Error("invalid_grant");
      },
    };
    const { pool, state } = fakePool(googleRow(new Date(NOW - 1000)));
    await expect(getCredential(pool, masterKey, "google-wm", failing, NOW)).rejects.toThrow(/invalid_grant/);
    expect(state.row!.status).toBe("reauth_required");
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
});
