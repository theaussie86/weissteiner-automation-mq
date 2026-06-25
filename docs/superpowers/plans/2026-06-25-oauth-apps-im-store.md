# OAuth-Apps im Credential Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OAuth-App-Zugänge (Client ID/Secret) für Google/Shopify aus dem Env in die verschlüsselte `credential`-Tabelle verlagern, sodass mehrere Apps parallel existieren und Tokens mit ihrer App verknüpft werden.

**Architecture:** Bestehende `credential`-Tabelle per Self-FK erweitern. App-Rows (`provider=google-app|shopify-app`) halten `{client_id, client_secret}`; Token-Rows referenzieren ihre App per `parent_credential_id` (ON DELETE CASCADE). Connect/Callback/Refresh lesen Client-Creds aus dem Store statt aus dem Env. Store-only, kein Env-Fallback.

**Tech Stack:** TypeScript, Node 24, Fastify, BullMQ, pg, node-pg-migrate, zod, vitest. AES-256-GCM via bestehende `crypto.ts`.

## Global Constraints

- Umlaute literal (ä/ö/ü/ß), kein ae/oe/ue/ss in Prosa/Kommentaren.
- `CREDENTIAL_MASTER_KEY`: 32 Byte kanonisches base64; ohne Wert ist der Store deaktiviert (503/Fehler).
- Klartext-Secrets nie in HTTP-Responses, Logs, Job-Payload oder Job-Archiv.
- Verschlüsselung: `encryptCredential(masterKey, name, data)`, Layout `iv(12) || authTag(16) || ciphertext`, AAD = Row-`name`.
- `name`-Slug-Regel: `CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/`, global unique über alle Rows.
- TDD: erst failing test, dann minimale Implementierung. Häufige Commits. Conventional-Commit-Messages auf Deutsch.
- Keine Route-Unit-Tests im Repo (kein fastify inject) — Route-Tasks via `npm run typecheck` + `npm test` + manueller Smoke absichern.

---

### Task 1: Migration — `parent_credential_id` + Provider-Check

**Files:**
- Create: `migrations/1750800000000_oauth_app.cjs`

**Interfaces:**
- Produces: Spalte `credential.parent_credential_id uuid` (FK self, ON DELETE CASCADE); Provider-Check akzeptiert `google-app`, `shopify-app`.

- [ ] **Step 1: Migration schreiben**

```js
/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.addColumn("credential", {
    parent_credential_id: {
      type: "uuid",
      references: "credential(id)",
      onDelete: "CASCADE",
    },
  });
  // Token-Rows zeigen auf ihre App-Row; Lookup beim Refresh über diesen FK.
  pgm.createIndex("credential", "parent_credential_id", {
    where: "parent_credential_id IS NOT NULL",
  });
  // Provider-Check um die App-Typen erweitern: erst alten Check droppen, dann neuen.
  pgm.dropConstraint("credential", "credential_provider_check");
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey', 'google-app', 'shopify-app')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("credential", "credential_provider_check");
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey')",
  });
  pgm.dropColumn("credential", "parent_credential_id");
};
```

- [ ] **Step 2: Dev-Infra hoch und Migration anwenden**

Run: `npm run dev:infra && node --env-file=.env --import=tsx -e "import('./src/api/index.ts')" & sleep 4; kill %1`
Alternativ (sauberer) kurz die API im Dev starten (`npm run dev:api`), bis `[migrate]`-Logs die neue Migration zeigen, dann stoppen.
Expected: Log enthält `[migrate] > Migrating files: > 1750800000000_oauth_app` ohne Fehler.

- [ ] **Step 3: Spalte verifizieren**

Run: `docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d postgres -c "\d credential"`
Expected: Spalte `parent_credential_id | uuid`, FK auf `credential(id)` ON DELETE CASCADE, Check-Constraint listet `google-app`/`shopify-app`.

- [ ] **Step 4: Commit**

```bash
git add migrations/1750800000000_oauth_app.cjs
git commit -m "feat: Migration parent_credential_id und App-Provider"
```

---

### Task 2: `store.ts` — Refresher-Signatur + Refresh über parent App-Creds

**Files:**
- Modify: `src/credentials/store.ts`
- Test: `src/credentials/store.test.ts`

**Interfaces:**
- Produces: `AppCreds { clientId, clientSecret }`; `Refresher = (data, appCreds: AppCreds) => Promise<{ data, expiresAt }>`; `getCredential` löst beim Refresh die parent App-Row auf.
- Consumes: `decryptCredential` (crypto.ts).

- [ ] **Step 1: Failing test — Refresh nutzt parent App-Creds**

In `store.test.ts` den Fake-Pool erweitern, sodass er neben der Token-Row auch eine App-Row per `where id = $1` beantwortet, und einen Test ergänzen:

```ts
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
        tokenRow.data_encrypted = params![0] as Buffer;
        tokenRow.status = (params!.length >= 3 ? params![2] : tokenRow.status) as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => log.push("release"),
  };
  return { pool: { connect: async () => client } as unknown as CredentialPool, log };
}

it("refreshes an expiring token using parent app credentials", async () => {
  const appData = encryptCredential(masterKey, "google-app-1", { client_id: "cid", client_secret: "csec" });
  const tokenRow = { name: "google-wm", provider: "google", data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }), token_expires_at: new Date(NOW + 1000), status: "ok", parent_credential_id: "app-uuid" };
  const { pool } = fakePoolWithApp(tokenRow, { id: "app-uuid", name: "google-app-1", data_encrypted: appData });
  let seenCreds: AppCreds | null = null;
  const refreshers: Record<string, Refresher> = {
    google: async (data, appCreds) => { seenCreds = appCreds; return { data: { ...data, accessToken: "fresh" }, expiresAt: new Date(NOW + 3600_000) }; },
  };
  const data = await getCredential(pool, masterKey, "google-wm", refreshers, NOW);
  expect(data.accessToken).toBe("fresh");
  expect(seenCreds).toEqual({ clientId: "cid", clientSecret: "csec" });
});

it("sets reauth_required when an expiring token has no resolvable app", async () => {
  const tokenRow = { name: "google-wm", provider: "google", data_encrypted: encryptCredential(masterKey, "google-wm", { accessToken: "old", refreshToken: "rt", scopes: [] }), token_expires_at: new Date(NOW + 1000), status: "ok", parent_credential_id: null };
  const { pool } = fakePoolWithApp(tokenRow, null);
  const refreshers: Record<string, Refresher> = { google: async (d) => ({ data: d, expiresAt: new Date(NOW) }) };
  await expect(getCredential(pool, masterKey, "google-wm", refreshers, NOW)).rejects.toThrow(/reauth/i);
  expect(tokenRow.status).toBe("reauth_required");
});
```

Add `type AppCreds` to the import from `store.js`.

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: FAIL — `getCredential` ruft Refresher noch ohne `appCreds`, kein Parent-Lookup.

- [ ] **Step 3: `store.ts` anpassen**

Refresher-Typ und Helper ergänzen, `getCredential`-Select um `parent_credential_id` erweitern, Refresh-Zweig auf App-Creds umstellen:

```ts
export interface AppCreds {
  clientId: string;
  clientSecret: string;
}

export interface Refresher {
  (data: Record<string, unknown>, appCreds: AppCreds): Promise<{ data: Record<string, unknown>; expiresAt: Date }>;
}

// Lädt Client-ID/Secret aus der verknüpften App-Row (plain select, kein Lock —
// das Secret ändert sich beim Token-Refresh nicht).
async function loadAppCreds(client: CredentialClient, masterKey: string, parentId: string | null): Promise<AppCreds | null> {
  if (!parentId) return null;
  const res = await client.query("select name, data_encrypted from credential where id = $1", [parentId]);
  const row = res.rows[0] as { name: string; data_encrypted: Buffer } | undefined;
  if (!row) return null;
  const data = decryptCredential(masterKey, row.name, row.data_encrypted);
  return { clientId: data.client_id as string, clientSecret: data.client_secret as string };
}
```

Im `getCredential`-Select `parent_credential_id` ergänzen und den Row-Typ erweitern:

```ts
    const result = await client.query(
      "select name, provider, data_encrypted, token_expires_at, status, parent_credential_id from credential where name = $1 for update",
      [name],
    );
    const row = result.rows[0] as
      | { name: string; provider: string; data_encrypted: Buffer; token_expires_at: Date | null; status: string; parent_credential_id: string | null }
      | undefined;
```

Den Refresh-Zweig ersetzen (ab `// Token läuft bald ab`):

```ts
    // Token läuft bald ab — Client-Creds der App laden und refreshen.
    const appCreds = await loadAppCreds(client, masterKey, row.parent_credential_id);
    if (!appCreds) {
      // Keine auflösbaren App-Creds → kein Refresh möglich, als reauth_required markieren.
      await client.query(
        "update credential set status = 'reauth_required', updated_at = now() where name = $1",
        [name],
      );
      await client.query("commit");
      committed = true;
      throw new Error(`Credential needs reauth: ${name} — App-Credentials nicht auflösbar`);
    }
    try {
      const refreshed = await refresher(data, appCreds);
```

Der bestehende `try/catch` bleibt ansonsten unverändert.

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: PASS (alte getCredential-Tests mit Refresh müssen auf den neuen Fake-Pool/Parent umgestellt sein — falls ein Alttest fehlschlägt, ihm eine `parent_credential_id` + App-Row geben).

- [ ] **Step 5: Commit**

```bash
git add src/credentials/store.ts src/credentials/store.test.ts
git commit -m "feat: Refresh zieht Client-Creds aus parent App-Row"
```

---

### Task 3: `store.ts` — OAuth-App CRUD + `parentCredentialId` in `upsertCredential`

**Files:**
- Modify: `src/credentials/store.ts`
- Test: `src/credentials/store.test.ts`

**Interfaces:**
- Produces: `AppProvider`, `upsertOAuthApp`, `getOAuthApp` → `OAuthApp { id, provider, clientId, clientSecret }`, `listOAuthApps`, `deleteOAuthApp`; `upsertCredential(..., { parentCredentialId? })`.

- [ ] **Step 1: Failing tests — App-CRUD + Roundtrip**

```ts
import { upsertOAuthApp, getOAuthApp, listOAuthApps, deleteOAuthApp } from "./store.js";

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
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: FAIL — Funktionen existieren nicht.

- [ ] **Step 3: Implementierung in `store.ts`**

```ts
export const APP_PROVIDERS = ["google", "shopify"] as const;
export type AppProvider = (typeof APP_PROVIDERS)[number];

export interface OAuthApp {
  id: string;
  provider: AppProvider;
  clientId: string;
  clientSecret: string;
}

export async function upsertOAuthApp(
  pool: CredentialPool,
  masterKey: string,
  opts: { name: string; provider: AppProvider; clientId: string; clientSecret: string },
): Promise<boolean> {
  const storedProvider = `${opts.provider}-app`;
  const data = { client_id: opts.clientId, client_secret: opts.clientSecret };
  const result = await pool.query(
    `insert into credential (name, provider, data_encrypted, status)
     values ($1, $2, $3, 'ok')
     on conflict (name) do update
       set data_encrypted = excluded.data_encrypted, updated_at = now()
       where credential.provider = excluded.provider`,
    [opts.name, storedProvider, encryptCredential(masterKey, opts.name, data)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getOAuthApp(pool: CredentialPool, masterKey: string, name: string): Promise<OAuthApp> {
  const result = await pool.query("select id, provider, data_encrypted from credential where name = $1", [name]);
  const row = result.rows[0] as { id: string; provider: string; data_encrypted: Buffer } | undefined;
  if (!row) throw new Error(`OAuth app not found: ${name}`);
  if (row.provider !== "google-app" && row.provider !== "shopify-app") {
    throw new Error(`Credential is not an OAuth app: ${name} (${row.provider})`);
  }
  const data = decryptCredential(masterKey, name, row.data_encrypted);
  return {
    id: row.id,
    provider: row.provider === "google-app" ? "google" : "shopify",
    clientId: data.client_id as string,
    clientSecret: data.client_secret as string,
  };
}

export async function listOAuthApps(pool: CredentialPool): Promise<{ name: string; provider: string }[]> {
  const result = await pool.query(
    "select name, provider from credential where provider in ('google-app','shopify-app') order by name",
  );
  return result.rows;
}

export async function deleteOAuthApp(pool: CredentialPool, name: string): Promise<boolean> {
  const result = await pool.query(
    "delete from credential where name = $1 and provider in ('google-app','shopify-app')",
    [name],
  );
  return (result.rowCount ?? 0) > 0;
}
```

`upsertCredential` um `parentCredentialId` erweitern:

```ts
export async function upsertCredential(
  pool: CredentialPool,
  masterKey: string,
  opts: { name: string; provider: Provider; data: Record<string, unknown>; tokenExpiresAt: Date | null; parentCredentialId?: string | null },
): Promise<boolean> {
  const result = await pool.query(
    `insert into credential (name, provider, data_encrypted, token_expires_at, status, parent_credential_id)
     values ($1, $2, $3, $4, 'ok', $5)
     on conflict (name) do update
       set data_encrypted = excluded.data_encrypted,
           token_expires_at = excluded.token_expires_at,
           status = 'ok',
           parent_credential_id = excluded.parent_credential_id,
           updated_at = now()
       where credential.provider = excluded.provider`,
    [opts.name, opts.provider, encryptCredential(masterKey, opts.name, opts.data), opts.tokenExpiresAt, opts.parentCredentialId ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/store.ts src/credentials/store.test.ts
git commit -m "feat: OAuth-App CRUD im Credential Store"
```

---

### Task 4: `state.ts` — App-Name im OAuth-State

**Files:**
- Modify: `src/credentials/state.ts`
- Test: `src/credentials/state.test.ts`

**Interfaces:**
- Produces: `StatePayload` enthält zusätzlich `app?: string` (Name der App-Row).

- [ ] **Step 1: Failing test**

In `state.test.ts` ergänzen:

```ts
it("round-trips the app name in the state payload", async () => {
  const store = new Map<string, string>();
  const redis = {
    set: async (k: string, v: string) => void store.set(k, v),
    getdel: async (k: string) => { const v = store.get(k) ?? null; store.delete(k); return v; },
  };
  const state = await createState(redis as any, { name: "kunde-a", provider: "google", app: "wa-main", scopes: ["s"] });
  const payload = await consumeState(redis as any, state);
  expect(payload?.app).toBe("wa-main");
});
```

- [ ] **Step 2: Run test — verify fail**

Run: `npx vitest run src/credentials/state.test.ts`
Expected: FAIL — `app` ist kein Feld von `StatePayload` (TS-Fehler bzw. assertion).

- [ ] **Step 3: `StatePayload` erweitern**

```ts
export interface StatePayload {
  name: string;
  provider: "google" | "shopify";
  app?: string;
  scopes?: string[];
  shop?: string;
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `npx vitest run src/credentials/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/state.ts src/credentials/state.test.ts
git commit -m "feat: App-Name im OAuth-State"
```

---

### Task 5: `config.ts` — Provider-Env entfernen

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts` (nur falls Referenzen vorhanden)

**Interfaces:**
- Produces: `Config` ohne `GOOGLE_CLIENT_ID/SECRET`, `SHOPIFY_CLIENT_ID/SECRET`.

- [ ] **Step 1: Referenzen prüfen**

Run: `grep -rn "GOOGLE_CLIENT_ID\|GOOGLE_CLIENT_SECRET\|SHOPIFY_CLIENT_ID\|SHOPIFY_CLIENT_SECRET" src`
Expected: Treffer in `config.ts`, `api/index.ts`, `worker/index.ts` (letztere zwei in späteren Tasks 6/8 entfernt). In `config.test.ts` ggf. Assertions.

- [ ] **Step 2: Vier Felder aus dem zod-Schema löschen**

In `src/config.ts` die vier Zeilen entfernen:

```ts
  GOOGLE_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  SHOPIFY_CLIENT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
  SHOPIFY_CLIENT_SECRET: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
```

Falls `config.test.ts` diese Keys prüft: die betreffenden Assertions entfernen.

- [ ] **Step 3: Run test — verify pass**

Run: `npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "refactor: Provider-Client-Env aus config entfernen"
```

---

### Task 6: `worker/index.ts` — Refresher ungated, App-Creds durchreichen

**Files:**
- Modify: `src/worker/index.ts`

**Interfaces:**
- Consumes: `Refresher` mit `(data, appCreds)` (Task 2), `refreshAccessToken` (google.ts).

- [ ] **Step 1: Refresher-Block ersetzen**

`src/worker/index.ts` Zeilen 20-29 (env-gated Block) ersetzen durch:

```ts
// Credential-Kontext (ADR-0002): Lazy-Refresh läuft zentral hier, nie in Job-Code.
// Client-ID/Secret kommen pro Token aus der verknüpften App-Row (getCredential löst sie auf).
const refreshers: Record<string, Refresher> = {
  google: async (data, appCreds) => {
    const result = await refreshAccessToken({
      clientId: appCreds.clientId,
      clientSecret: appCreds.clientSecret,
      refreshToken: data.refreshToken as string,
    });
    return { data: { ...data, accessToken: result.accessToken }, expiresAt: result.expiresAt };
  },
};
```

Den `import { getCredential, type Refresher }` um `type AppCreds` erweitern, falls TS es verlangt (nur wenn `AppCreds` direkt referenziert wird — hier nicht nötig, da inferiert).

- [ ] **Step 2: Typecheck + Tests**

Run: `npm run typecheck && npm test`
Expected: PASS — keine `config.GOOGLE_*`-Referenz mehr im Worker.

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat: Worker-Refresher nutzt App-Creds statt Env"
```

---

### Task 7: `api/index.ts` — OAuth-App-CRUD-Routen

**Files:**
- Modify: `src/api/index.ts`

**Interfaces:**
- Consumes: `upsertOAuthApp`, `listOAuthApps`, `deleteOAuthApp`, `APP_PROVIDERS` (Task 3).
- Produces: `POST/GET /admin/credentials/oauth-app`, `DELETE /admin/credentials/oauth-app/:name`.

- [ ] **Step 1: Imports erweitern**

Im Credential-Store-Import-Block (`from "../credentials/store.js"`) ergänzen: `upsertOAuthApp, listOAuthApps, deleteOAuthApp`.

- [ ] **Step 2: Routen ergänzen (vor dem Connect-Block, nach `DELETE /admin/credentials/:name`)**

```ts
// OAuth-App-Verwaltung: Client-ID/Secret verschlüsselt im Store, mehrere Apps pro Provider.
app.post<{ Body: { name: string; provider: string; clientId: string; clientSecret: string } }>(
  "/admin/credentials/oauth-app",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!config.CREDENTIAL_MASTER_KEY) return reply.code(503).send({ error: "Credential store not configured" });
    const { name, provider, clientId, clientSecret } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (provider !== "google" && provider !== "shopify") {
      return reply.code(422).send({ error: "provider must be 'google' or 'shopify'" });
    }
    if (typeof clientId !== "string" || !clientId || typeof clientSecret !== "string" || !clientSecret) {
      return reply.code(422).send({ error: "clientId and clientSecret required" });
    }
    const ok = await upsertOAuthApp(db, config.CREDENTIAL_MASTER_KEY, { name, provider, clientId, clientSecret });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${name}` });
    return reply.code(201).send({ name, provider: `${provider}-app` });
  },
);

app.get("/admin/credentials/oauth-app", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const apps = await listOAuthApps(db);
  return { apps, count: apps.length };
});

app.delete<{ Params: { name: string } }>("/admin/credentials/oauth-app/:name", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const removed = await deleteOAuthApp(db, request.params.name);
  if (!removed) return reply.code(404).send({ error: "OAuth app not found" });
  return reply.code(204).send();
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: Admin-CRUD für OAuth-Apps"
```

---

### Task 8: `api/index.ts` — Connect/Callback auf App-Referenz umstellen

**Files:**
- Modify: `src/api/index.ts`

**Interfaces:**
- Consumes: `getOAuthApp` → `{ id, provider, clientId, clientSecret }` (Task 3), `StatePayload.app` (Task 4).

- [ ] **Step 1: Import ergänzen**

Im Store-Import-Block `getOAuthApp` ergänzen.

- [ ] **Step 2: `google/connect` ersetzen**

```ts
app.post<{ Body: { name: string; app: string; scopes: string[] } }>(
  "/admin/credentials/google/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !redirectUri) {
      return reply.code(503).send({ error: "Credential store not configured" });
    }
    const { name, app, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof app !== "string" || !app) return reply.code(422).send({ error: "app (OAuth app name) required" });
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    let oauthApp;
    try {
      oauthApp = await getOAuthApp(db, config.CREDENTIAL_MASTER_KEY, app);
    } catch {
      return reply.code(422).send({ error: `OAuth app not found: ${app}` });
    }
    if (oauthApp.provider !== "google") return reply.code(422).send({ error: `App '${app}' is not a google app` });
    const state = await createState(redis, { name, provider: "google", app, scopes });
    const authUrl = google.buildAuthUrl({ clientId: oauthApp.clientId, redirectUri, scopes, state });
    return { authUrl };
  },
);
```

- [ ] **Step 3: `shopify/connect` ersetzen**

```ts
app.post<{ Body: { name: string; app: string; shop: string; scopes: string[] } }>(
  "/admin/credentials/shopify/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("shopify");
    if (!config.CREDENTIAL_MASTER_KEY || !redirectUri) {
      return reply.code(503).send({ error: "Credential store not configured" });
    }
    const { name, app, shop, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof app !== "string" || !app) return reply.code(422).send({ error: "app (OAuth app name) required" });
    if (typeof shop !== "string" || !shopify.SHOP_PATTERN.test(shop)) {
      return reply.code(422).send({ error: "Invalid shop: expected <shop>.myshopify.com" });
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    let oauthApp;
    try {
      oauthApp = await getOAuthApp(db, config.CREDENTIAL_MASTER_KEY, app);
    } catch {
      return reply.code(422).send({ error: `OAuth app not found: ${app}` });
    }
    if (oauthApp.provider !== "shopify") return reply.code(422).send({ error: `App '${app}' is not a shopify app` });
    const state = await createState(redis, { name, provider: "shopify", app, shop });
    const authUrl = shopify.buildAuthUrl({ clientId: oauthApp.clientId, shop, scopes, redirectUri, state });
    return { authUrl };
  },
);
```

- [ ] **Step 4: `callback/google` ersetzen**

```ts
app.get<{ Querystring: { code?: string; state?: string } }>(
  "/credentials/callback/google",
  async (request, reply) => {
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !redirectUri) {
      return reply.code(503).send({ error: "Credential store not configured" });
    }
    const { code, state } = request.query;
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "google" || !payload.app) {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    let oauthApp;
    try {
      oauthApp = await getOAuthApp(db, config.CREDENTIAL_MASTER_KEY, payload.app);
    } catch {
      return reply.code(409).send({ error: `OAuth app gone: ${payload.app}` });
    }
    const tokens = await google.exchangeCode({
      clientId: oauthApp.clientId,
      clientSecret: oauthApp.clientSecret,
      redirectUri,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "google",
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scopes: tokens.scopes },
      tokenExpiresAt: tokens.expiresAt,
      parentCredentialId: oauthApp.id,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (google) verbunden. Fenster kann geschlossen werden.`);
  },
);
```

- [ ] **Step 5: `callback/shopify` ersetzen (HMAC nach State-Konsum)**

```ts
app.get<{ Querystring: Record<string, string | undefined> }>(
  "/credentials/callback/shopify",
  async (request, reply) => {
    if (!config.CREDENTIAL_MASTER_KEY) {
      return reply.code(503).send({ error: "Credential store not configured" });
    }
    const { code, state, shop } = request.query;
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "shopify" || payload.shop !== shop || !payload.app) {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    let oauthApp;
    try {
      oauthApp = await getOAuthApp(db, config.CREDENTIAL_MASTER_KEY, payload.app);
    } catch {
      return reply.code(409).send({ error: `OAuth app gone: ${payload.app}` });
    }
    // HMAC erst nach State-Konsum: das Secret stammt aus der referenzierten App-Row.
    if (!shopify.verifyCallbackHmac(request.query, oauthApp.clientSecret)) {
      return reply.code(403).send({ error: "Invalid HMAC" });
    }
    const tokens = await shopify.exchangeCode({
      shop: payload.shop!,
      clientId: oauthApp.clientId,
      clientSecret: oauthApp.clientSecret,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "shopify",
      data: { shop: tokens.shop, accessToken: tokens.accessToken },
      tokenExpiresAt: null,
      parentCredentialId: oauthApp.id,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (shopify) verbunden. Fenster kann geschlossen werden.`);
  },
);
```

- [ ] **Step 6: Typecheck + Tests**

Run: `npm run typecheck && npm test`
Expected: PASS — keine `config.GOOGLE_*`/`config.SHOPIFY_*`-Referenz mehr in `api/index.ts`.

- [ ] **Step 7: Manueller Smoke (lokal, dev-Infra + API + ngrok optional)**

```bash
# App anlegen
curl -sf -XPOST localhost:5001/admin/credentials/oauth-app -H "x-admin-key: $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"wa-main","provider":"google","clientId":"x","clientSecret":"y"}' | jq .
# Connect liefert authUrl mit clientId aus der App-Row
curl -sf -XPOST localhost:5001/admin/credentials/google/connect -H "x-admin-key: $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"kunde-a","app":"wa-main","scopes":["https://www.googleapis.com/auth/drive.readonly"]}' | jq .
```
Expected: 201 bzw. `{ authUrl: "...client_id=x..." }`. (Vollständiger OAuth-Roundtrip braucht echte Google-App — nur authUrl-Form prüfen.)

- [ ] **Step 8: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: Connect/Callback referenzieren OAuth-App aus dem Store"
```

---

### Task 9: Compose + Doku

**Files:**
- Modify: `docker-compose.yml`
- Modify: `README.md`
- Modify: `CONTEXT.md` (nur falls Provider-Env dort genannt)

**Interfaces:**
- Produces: `CREDENTIAL_MASTER_KEY` an api+worker; Doku ohne Provider-Env, mit oauth-app-Endpoints.

- [ ] **Step 1: `docker-compose.yml` — Master-Key durchreichen**

Im `api`-Service unter `environment` ergänzen:

```yaml
      - CREDENTIAL_MASTER_KEY=${CREDENTIAL_MASTER_KEY}
```

Im `worker`-Service unter `environment` dieselbe Zeile ergänzen. Keine `GOOGLE_*`/`SHOPIFY_*`-Zeilen hinzufügen (gab es dort nicht).

- [ ] **Step 2: README aktualisieren**

Im Abschnitt „Credential Store (ADR-0002)" die Env-Tabelle: Zeilen `GOOGLE_CLIENT_ID/SECRET` und `SHOPIFY_CLIENT_ID/SECRET` entfernen, `CREDENTIAL_MASTER_KEY` behalten. Endpoint-Liste ergänzen:

```markdown
- `POST /admin/credentials/oauth-app` - OAuth-App anlegen (`{name, provider: "google"|"shopify", clientId, clientSecret}`); Client-Secret wird verschlüsselt im Store abgelegt
- `GET /admin/credentials/oauth-app` - App-Liste ohne Secrets
- `DELETE /admin/credentials/oauth-app/:name` - App löschen (kaskadiert: verknüpfte Tokens werden mitgelöscht)
```

Und den Connect-Punkt anpassen: `POST .../google/connect` (`{name, app, scopes[]}`) bzw. `.../shopify/connect` (`{name, app, shop, scopes[]}`) — `app` referenziert eine zuvor angelegte OAuth-App.

Redirect-URI-Zeilen (`GOOGLE_CLIENT_ID/SECRET ... Redirect-URI`) entfernen oder in Fließtext überführen: Redirect-URI je Provider bleibt `<PUBLIC_BASE_URL>/credentials/callback/<provider>`, ist in der Google-/Shopify-App zu hinterlegen.

- [ ] **Step 3: CONTEXT.md prüfen**

Run: `grep -n "GOOGLE_CLIENT\|SHOPIFY_CLIENT" CONTEXT.md`
Falls Treffer: auf den Store-only-Stand anpassen (Client-Creds liegen im Credential Store, nicht im Env).

- [ ] **Step 4: Voller Testlauf**

Run: `npm run typecheck && npm test`
Expected: PASS, alle Suites grün.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml README.md CONTEXT.md
git commit -m "docs: OAuth-Apps im Store, Master-Key an api+worker"
```

---

## Deploy-Nachlauf (nach Merge, separat)

1. `CREDENTIAL_MASTER_KEY` erzeugen (`openssl rand -base64 32`), in Coolify-Env des `mq-app`-Projekts setzen (per API: `PATCH /api/v1/applications/<uuid>/envs`).
2. `git push origin main` → CI grün → Coolify deployt → Migration `1750800000000_oauth_app` läuft automatisch beim API-Boot (additiv, kein Datenverlust).
3. Erste OAuth-App per `POST /admin/credentials/oauth-app` anlegen, dann Connect-Flow durchklicken.

## Self-Review

- **Spec-Coverage:** Schema (T1), Crypto-unverändert (T2/T3 nutzen bestehende Funktionen), Store-Funktionen inkl. parent-Refresh (T2/T3), Provider-Module unverändert (T6 nutzt sie), API-Routen (T7/T8), State (T4), Config/Compose (T5/T9), Deploy (Nachlauf), Tests (T2/T3/T4 unit; T6/T7/T8 typecheck+smoke da kein Route-Harness). Follow-up „reauth bei nicht auflösbaren App-Creds" → T2 Step 1/3. Alle Spec-Punkte abgedeckt.
- **Platzhalter:** keine TBD/TODO; jeder Code-Step zeigt vollständigen Code.
- **Typ-Konsistenz:** `Refresher(data, appCreds)`, `AppCreds{clientId,clientSecret}`, `OAuthApp{id,provider,clientId,clientSecret}`, `upsertCredential(...,{parentCredentialId})`, `StatePayload.app`, `getOAuthApp` → base provider `google`/`shopify` — durchgängig identisch in T2/T3/T6/T8.
- **Cascade-Hinweis:** FK-CASCADE wird per Migration (T1) erzwungen, nicht per Unit-Test (Fake-Pool kann keine FK simulieren) — bewusst, entspricht der bestehenden „per Reasoning verifiziert"-Linie des Repos.
