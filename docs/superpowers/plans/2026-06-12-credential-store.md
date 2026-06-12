# Credential Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verschlüsselter Credential Store in Postgres mit Google/Shopify-OAuth-Flows und zentralem Token-Refresh (Spec: `docs/superpowers/specs/2026-06-12-credential-store-design.md`, ADR-0002).

**Architecture:** Ein Modul `src/credentials/` (crypto, store, providers, state) mit einer `credential`-Tabelle. Admin-initiierter OAuth-Connect über Admin-Endpoints + öffentliche Callback-Routen (State in Redis). Worker bekommt einen `JobContext` mit `getCredential`; Lazy-Refresh mit `select … for update`, Background-Refresh als repeatable Job.

**Tech Stack:** Node 24, TypeScript ESM, Fastify 5, pg, node-pg-migrate, BullMQ, ioredis, Zod 4, Vitest. AES-256-GCM aus `node:crypto`. HTTP zu Google/Shopify via global `fetch` (injizierbar für Tests).

**Konventionen (Haus-Stil):**
- Imports mit `.js`-Endung (ESM), absolute Pfade nur in Tools, relative in Code-Imports
- Tests: Vitest, reine Unit-Tests mit injizierten Fakes (siehe `src/storage/temp-url.test.ts`)
- Deutsche Umlaute in Kommentaren (ä, ö, ü, ß)
- Keine em-dashes in Texten, nur Hyphen
- Commits: Conventional Commits, deutsch, Subject ≤ 50 Zeichen

**Tests laufen mit:** `npx vitest run <pfad>` · alles: `npm test` · Typen: `npm run typecheck`

---

## Datei-Struktur

| Datei | Verantwortung |
|---|---|
| `migrations/1749740000000_credential.cjs` | Tabelle `credential` |
| `src/config.ts` (modify) | Neue Env-Vars |
| `src/credentials/crypto.ts` | AES-256-GCM encrypt/decrypt, AAD = name |
| `src/credentials/state.ts` | OAuth-State in Redis (single-use, TTL) |
| `src/credentials/providers/google.ts` | Auth-URL, Code-Exchange, Refresh |
| `src/credentials/providers/shopify.ts` | Auth-URL, HMAC-Check, Code-Exchange |
| `src/credentials/store.ts` | getCredential (Lazy-Refresh, Lock), upsert, list, expiring |
| `src/jobs/registry.ts` (modify) | `JobContext` als zweiter Processor-Parameter |
| `src/worker/index.ts` (modify) | Context-Wiring, Refresh-Scheduler |
| `src/jobs/credentials-refresh.ts` | Repeatable Background-Refresh |
| `src/api/index.ts` (modify) | Admin-Routen, Connect/Callback-Routen, Auth-Hook-Skip |
| `README.md` (modify) | Betrieb/Env-Doku |

---

### Task 1: Config-Erweiterung

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

In `src/config.test.ts` anhängen:

```ts
describe("CREDENTIAL_MASTER_KEY", () => {
  it("accepts 32-byte base64 key", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const config = loadConfig({ ...base, CREDENTIAL_MASTER_KEY: key });
    expect(config.CREDENTIAL_MASTER_KEY).toBe(key);
  });

  it("rejects keys that are not 32 bytes", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    expect(() => loadConfig({ ...base, CREDENTIAL_MASTER_KEY: short })).toThrow(/CREDENTIAL_MASTER_KEY/);
  });

  it("treats empty string as unset", () => {
    const config = loadConfig({ ...base, CREDENTIAL_MASTER_KEY: "" });
    expect(config.CREDENTIAL_MASTER_KEY).toBeUndefined();
  });
});

describe("OAuth client config", () => {
  it("treats empty strings as unset", () => {
    const config = loadConfig({ ...base, GOOGLE_CLIENT_ID: "", SHOPIFY_CLIENT_SECRET: "" });
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(config.SHOPIFY_CLIENT_SECRET).toBeUndefined();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL (unbekannte Keys werden von Zod ignoriert, `CREDENTIAL_MASTER_KEY` undefined statt Wert bzw. kein Throw)

- [ ] **Step 3: Config implementieren**

In `src/config.ts` im `envSchema` nach `PUBLIC_BASE_URL` ergänzen:

```ts
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
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: Env-Config für Credential Store"
```

---

### Task 2: Migration `credential`

**Files:**
- Create: `migrations/1749740000000_credential.cjs`

- [ ] **Step 1: Migration schreiben**

```js
/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable("credential", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true, unique: true },
    provider: { type: "text", notNull: true },
    data_encrypted: { type: "bytea", notNull: true },
    token_expires_at: { type: "timestamptz" },
    status: { type: "text", notNull: true, default: "ok" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey')",
  });
  pgm.addConstraint("credential", "credential_status_check", {
    check: "status in ('ok', 'reauth_required')",
  });
};

exports.down = (pgm) => {
  pgm.dropTable("credential");
};
```

- [ ] **Step 2: Migration lokal verifizieren**

Run: `npm run dev:infra && DATABASE_URL=postgres://mq:mq@localhost:5432/mq npx node-pg-migrate up -m migrations`

(Connection-String aus `.env` übernehmen, falls abweichend — `grep DATABASE_URL .env`.)
Expected: `Migrating files: ... 1749740000000_credential` ohne Fehler. Danach `down`-Probe:

Run: `DATABASE_URL=... npx node-pg-migrate down -m migrations && DATABASE_URL=... npx node-pg-migrate up -m migrations`
Expected: down + up laufen sauber durch.

- [ ] **Step 3: Commit**

```bash
git add migrations/1749740000000_credential.cjs
git commit -m "feat: Migration credential-Tabelle"
```

---

### Task 3: Crypto-Modul

**Files:**
- Create: `src/credentials/crypto.ts`
- Test: `src/credentials/crypto.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

`src/credentials/crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./crypto.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");
const data = { accessToken: "ya29.abc", refreshToken: "1//xyz", scopes: ["a"] };

describe("credential crypto", () => {
  it("roundtrips data", () => {
    const blob = encryptCredential(masterKey, "google-wachmacherei", data);
    expect(decryptCredential(masterKey, "google-wachmacherei", blob)).toEqual(data);
  });

  it("produces different ciphertext per call (random IV)", () => {
    const a = encryptCredential(masterKey, "n", data);
    const b = encryptCredential(masterKey, "n", data);
    expect(a.equals(b)).toBe(false);
  });

  it("fails with wrong key", () => {
    const blob = encryptCredential(masterKey, "n", data);
    expect(() => decryptCredential(otherKey, "n", blob)).toThrow();
  });

  it("fails when name does not match (AAD-Bindung)", () => {
    const blob = encryptCredential(masterKey, "google-a", data);
    expect(() => decryptCredential(masterKey, "google-b", blob)).toThrow();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/credentials/crypto.test.ts`
Expected: FAIL (Modul existiert nicht)

- [ ] **Step 3: Implementieren**

`src/credentials/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM mit AAD = Credential-Name: bindet den Ciphertext an die Zeile,
// ein zwischen Zeilen getauschter Blob schlägt beim Auth-Tag-Check fehl (Spec, ADR-0002).
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptCredential(masterKeyB64: string, name: string, data: Record<string, unknown>): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredential(masterKeyB64: string, name: string, blob: Buffer): Record<string, unknown> {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/credentials/crypto.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials/crypto.ts src/credentials/crypto.test.ts
git commit -m "feat: AES-256-GCM Crypto für Credential Store"
```

---

### Task 4: OAuth-State in Redis

**Files:**
- Create: `src/credentials/state.ts`
- Test: `src/credentials/state.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

`src/credentials/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { consumeState, createState, type StatePayload } from "./state.js";

// Fake-Redis: nur die zwei genutzten Befehle (set mit EX, getdel).
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: async (key: string, value: string, _ex: string, _ttl: number) => {
      store.set(key, value);
      return "OK";
    },
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
}

const payload: StatePayload = { name: "google-wachmacherei", provider: "google", scopes: ["a"] };

describe("oauth state", () => {
  it("roundtrips payload and is single-use", async () => {
    const redis = fakeRedis();
    const state = await createState(redis, payload);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(await consumeState(redis, state)).toEqual(payload);
    expect(await consumeState(redis, state)).toBeNull();
  });

  it("returns null for unknown state", async () => {
    expect(await consumeState(fakeRedis(), "deadbeef")).toBeNull();
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/credentials/state.test.ts`
Expected: FAIL (Modul existiert nicht)

- [ ] **Step 3: Implementieren**

`src/credentials/state.ts`:

```ts
import { randomBytes } from "node:crypto";

// OAuth-State: 32 Byte Zufall als Redis-Key, single-use (getdel), 10 min TTL.
// Schützt die öffentlichen Callback-Routen — nur wer den Connect gestartet hat, kann abschließen.
const STATE_TTL_SECONDS = 600;

export interface StatePayload {
  name: string;
  provider: "google" | "shopify";
  scopes?: string[];
  shop?: string;
}

// Strukturelles Interface statt ioredis-Typ: hält das Modul testbar ohne echtes Redis.
export interface StateRedis {
  set(key: string, value: string, ex: "EX", ttl: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

export async function createState(redis: StateRedis, payload: StatePayload): Promise<string> {
  const state = randomBytes(32).toString("hex");
  await redis.set(`oauth-state:${state}`, JSON.stringify(payload), "EX", STATE_TTL_SECONDS);
  return state;
}

export async function consumeState(redis: StateRedis, state: string): Promise<StatePayload | null> {
  const raw = await redis.getdel(`oauth-state:${state}`);
  return raw ? (JSON.parse(raw) as StatePayload) : null;
}
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/credentials/state.test.ts`
Expected: PASS (2 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials/state.ts src/credentials/state.test.ts
git commit -m "feat: Single-use OAuth-State in Redis"
```

---

### Task 5: Google-Provider

**Files:**
- Create: `src/credentials/providers/google.ts`
- Test: `src/credentials/providers/google.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

`src/credentials/providers/google.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAuthUrl, exchangeCode, refreshAccessToken } from "./google.js";

const client = { clientId: "cid", clientSecret: "csec", redirectUri: "https://mq.example.com/credentials/callback/google" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("buildAuthUrl", () => {
  it("builds consent url with offline access", () => {
    const url = new URL(buildAuthUrl({ ...client, scopes: ["https://www.googleapis.com/auth/drive"], state: "st123" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(client.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st123");
  });
});

describe("exchangeCode", () => {
  it("parses token response", async () => {
    const { fn, calls } = fakeFetch(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "a b",
    });
    const now = 1_750_000_000_000;
    const result = await exchangeCode({ ...client, code: "c0de" }, fn, now);
    expect(result).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["a", "b"],
      expiresAt: new Date(now + 3600_000),
    });
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(calls[0]!.init.body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("c0de");
  });

  it("throws on error response", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant" });
    await expect(exchangeCode({ ...client, code: "bad" }, fn)).rejects.toThrow(/invalid_grant/);
  });
});

describe("refreshAccessToken", () => {
  it("parses refresh response", async () => {
    const { fn, calls } = fakeFetch(200, { access_token: "at2", expires_in: 3599 });
    const now = 1_750_000_000_000;
    const result = await refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fn, now);
    expect(result).toEqual({ accessToken: "at2", expiresAt: new Date(now + 3599_000) });
    const params = new URLSearchParams(calls[0]!.init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt");
  });

  it("throws on revoked token", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant" });
    await expect(refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fn)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/credentials/providers/google.test.ts`
Expected: FAIL (Modul existiert nicht)

- [ ] **Step 3: Implementieren**

`src/credentials/providers/google.ts`:

```ts
// Google OAuth 2.0 (Web Server Flow). access_type=offline + prompt=consent
// erzwingt ein Refresh-Token auch bei Re-Connect (Spec).
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Google token endpoint ${response.status}: ${json.error ?? "unknown"}`);
  }
  return json;
}

export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<GoogleTokens> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
    fetchFn,
  );
  return {
    accessToken: json.access_token as string,
    refreshToken: json.refresh_token as string,
    scopes: typeof json.scope === "string" ? json.scope.split(" ") : [],
    expiresAt: new Date(now + (json.expires_in as number) * 1000),
  };
}

export async function refreshAccessToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ accessToken: string; expiresAt: Date }> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
    fetchFn,
  );
  return {
    accessToken: json.access_token as string,
    expiresAt: new Date(now + (json.expires_in as number) * 1000),
  };
}
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/credentials/providers/google.test.ts`
Expected: PASS (5 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials/providers/google.ts src/credentials/providers/google.test.ts
git commit -m "feat: Google-OAuth-Provider"
```

---

### Task 6: Shopify-Provider

**Files:**
- Create: `src/credentials/providers/shopify.ts`
- Test: `src/credentials/providers/shopify.test.ts`

Hinweis zur Spec: Shopify verlangt `scope` in der Authorize-URL — der Connect-Body bekommt deshalb `scopes[]` zusätzlich zu `{name, shop}` (bewusste Spec-Präzisierung).

- [ ] **Step 1: Failing Tests schreiben**

`src/credentials/providers/shopify.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthUrl, exchangeCode, verifyCallbackHmac } from "./shopify.js";

describe("buildAuthUrl", () => {
  it("builds shop-specific authorize url", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        shop: "demo.myshopify.com",
        scopes: ["read_products", "write_orders"],
        redirectUri: "https://mq.example.com/credentials/callback/shopify",
        state: "st123",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://demo.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("read_products,write_orders");
    expect(url.searchParams.get("redirect_uri")).toBe("https://mq.example.com/credentials/callback/shopify");
    expect(url.searchParams.get("state")).toBe("st123");
  });
});

describe("verifyCallbackHmac", () => {
  function sign(params: Record<string, string>, secret: string): string {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return createHmac("sha256", secret).update(message).digest("hex");
  }

  it("accepts valid hmac", () => {
    const params = { code: "c", shop: "demo.myshopify.com", state: "st", timestamp: "123" };
    const hmac = sign(params, "csec");
    expect(verifyCallbackHmac({ ...params, hmac }, "csec")).toBe(true);
  });

  it("rejects tampered params", () => {
    const params = { code: "c", shop: "demo.myshopify.com", state: "st", timestamp: "123" };
    const hmac = sign(params, "csec");
    expect(verifyCallbackHmac({ ...params, shop: "evil.myshopify.com", hmac }, "csec")).toBe(false);
  });

  it("rejects missing hmac", () => {
    expect(verifyCallbackHmac({ code: "c" }, "csec")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posts to shop token endpoint and parses access token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_products" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await exchangeCode(
      { shop: "demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "c0de" },
      fn,
    );
    expect(result).toEqual({ shop: "demo.myshopify.com", accessToken: "shpat_x" });
    expect(calls[0]!.url).toBe("https://demo.myshopify.com/admin/oauth/access_token");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ client_id: "cid", client_secret: "csec", code: "c0de" });
  });

  it("throws on error response", async () => {
    const fn = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ shop: "demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "bad" }, fn),
    ).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/credentials/providers/shopify.test.ts`
Expected: FAIL (Modul existiert nicht)

- [ ] **Step 3: Implementieren**

`src/credentials/providers/shopify.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify OAuth (Authorization Code Grant). Tokens laufen nicht ab — kein Refresh.
// Callback-Parameter sind per HMAC-SHA256 mit dem Client-Secret signiert.

export function buildAuthUrl(opts: {
  clientId: string;
  shop: string;
  scopes: string[];
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://${opts.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("scope", opts.scopes.join(","));
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export function verifyCallbackHmac(query: Record<string, string | undefined>, clientSecret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .filter((k) => rest[k] !== undefined)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  if (expected.length !== hmac.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(hmac, "utf8"));
}

export async function exchangeCode(
  opts: { shop: string; clientId: string; clientSecret: string; code: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ shop: string; accessToken: string }> {
  const response = await fetchFn(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code: opts.code }),
  });
  if (!response.ok) {
    throw new Error(`Shopify token endpoint ${response.status}`);
  }
  const json = (await response.json()) as { access_token: string };
  return { shop: opts.shop, accessToken: json.access_token };
}
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/credentials/providers/shopify.test.ts`
Expected: PASS (6 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials/providers/shopify.ts src/credentials/providers/shopify.test.ts
git commit -m "feat: Shopify-OAuth-Provider"
```

---

### Task 7: Store mit Lazy-Refresh

**Files:**
- Create: `src/credentials/store.ts`
- Test: `src/credentials/store.test.ts`

- [ ] **Step 1: Failing Tests schreiben**

`src/credentials/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: FAIL (Modul existiert nicht)

- [ ] **Step 3: Implementieren**

`src/credentials/store.ts`:

```ts
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
      return data;
    }
    let refreshed: { data: Record<string, unknown>; expiresAt: Date };
    try {
      refreshed = await refresher(data);
    } catch (err) {
      await client.query(
        "update credential set data_encrypted = $1, token_expires_at = $2, status = $3, updated_at = now() where name = $4",
        [row.data_encrypted, row.token_expires_at, "reauth_required", name],
      );
      await client.query("commit");
      throw err;
    }
    await client.query(
      "update credential set data_encrypted = $1, token_expires_at = $2, status = $3, updated_at = now() where name = $4",
      [encryptCredential(masterKey, name, refreshed.data), refreshed.expiresAt, "ok", name],
    );
    await client.query("commit");
    return refreshed.data;
  } catch (err) {
    await client.query("rollback").catch(() => {});
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
```

- [ ] **Step 4: Tests grün**

Run: `npx vitest run src/credentials/store.test.ts`
Expected: PASS (6 Tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler

- [ ] **Step 6: Commit**

```bash
git add src/credentials/store.ts src/credentials/store.test.ts
git commit -m "feat: Credential Store mit Lazy-Refresh und Lock"
```

---

### Task 8: JobContext in Registry und Worker

**Files:**
- Modify: `src/jobs/registry.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Registry erweitern**

In `src/jobs/registry.ts` das Interface ändern (Rest unverändert):

```ts
import { z } from "zod";
import type pg from "pg";

export const QUEUES = ["media", "integrations"] as const;
export type QueueName = (typeof QUEUES)[number];

// Worker-seitiger Kontext: Credential-Zugriff und DB für Jobs, die mehr brauchen
// (z.B. credentials.refresh). API ruft process nie auf.
export interface JobContext {
  db: pg.Pool;
  getCredential: (name: string) => Promise<Record<string, unknown>>;
}

export interface JobType<P extends z.ZodTypeAny = z.ZodTypeAny> {
  /** e.g. "media.extract-audio" */
  name: string;
  queue: QueueName;
  payloadSchema: P;
  process: (payload: z.infer<P>, ctx: JobContext) => Promise<unknown>;
}
```

Bestehende Jobs (`ping`, `media`, `cleanup`) deklarieren nur den ersten Parameter — das bleibt typkompatibel, keine Änderung nötig.

- [ ] **Step 2: Worker-Wiring**

In `src/worker/index.ts`:

Imports ergänzen:

```ts
import { getCredential, type Refresher } from "../credentials/store.js";
import { refreshAccessToken } from "../credentials/providers/google.js";
import type { JobContext } from "../jobs/registry.js";
```

Nach `const db = new pg.Pool(...)` einfügen:

```ts
// Credential-Kontext (ADR-0002): Lazy-Refresh läuft zentral hier, nie in Job-Code.
const refreshers: Record<string, Refresher> = {};
if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
  const clientId = config.GOOGLE_CLIENT_ID;
  const clientSecret = config.GOOGLE_CLIENT_SECRET;
  refreshers.google = async (data) => {
    const result = await refreshAccessToken({ clientId, clientSecret, refreshToken: data.refreshToken as string });
    return { data: { ...data, accessToken: result.accessToken }, expiresAt: result.expiresAt };
  };
}
const ctx: JobContext = {
  db,
  getCredential: (name) => {
    if (!config.CREDENTIAL_MASTER_KEY) {
      return Promise.reject(new Error("Credential store not configured (CREDENTIAL_MASTER_KEY missing)"));
    }
    return getCredential(db, config.CREDENTIAL_MASTER_KEY, name, refreshers);
  },
};
```

Processor-Aufruf ändern — aus

```ts
        return jobType.process(payload);
```

wird

```ts
        return jobType.process(payload, ctx);
```

- [ ] **Step 3: Typecheck + alle Tests**

Run: `npm run typecheck && npm test`
Expected: keine Fehler, alle Tests grün

- [ ] **Step 4: Commit**

```bash
git add src/jobs/registry.ts src/worker/index.ts
git commit -m "feat: JobContext mit getCredential im Worker"
```

---

### Task 9: Background-Refresh-Job

**Files:**
- Create: `src/jobs/credentials-refresh.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/api/index.ts` (Import für Registry-Vollständigkeit)

- [ ] **Step 1: Job-Modul schreiben**

`src/jobs/credentials-refresh.ts`:

```ts
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
```

- [ ] **Step 2: Scheduler im Worker**

In `src/worker/index.ts`:

Import ergänzen:

```ts
import { CREDENTIALS_REFRESH_JOB_NAME } from "../jobs/credentials-refresh.js";
```

(Die Seiteneffekt-Registrierung läuft über diesen Import mit.)

Nach dem bestehenden Cleanup-Scheduler-Block einfügen:

```ts
// Repeatable Background-Refresh (Spec) — nur sinnvoll wenn der Store konfiguriert ist.
if (config.WORKER_QUEUES.includes("integrations") && config.CREDENTIAL_MASTER_KEY) {
  const integrationsQueue = new Queue("integrations", { connection });
  await integrationsQueue.upsertJobScheduler(
    `${CREDENTIALS_REFRESH_JOB_NAME}-30min`,
    { every: 1_800_000 },
    { name: CREDENTIALS_REFRESH_JOB_NAME },
  );
  await integrationsQueue.close();
}
```

- [ ] **Step 3: API-Import ergänzen**

In `src/api/index.ts` bei den Job-Imports (`import "../jobs/cleanup.js";`) ergänzen:

```ts
import "../jobs/credentials-refresh.js";
```

(API validiert Job-Typen gegen die Registry — der Typ muss auch dort bekannt sein.)

- [ ] **Step 4: Typecheck + Tests**

Run: `npm run typecheck && npm test`
Expected: grün

- [ ] **Step 5: Commit**

```bash
git add src/jobs/credentials-refresh.ts src/worker/index.ts src/api/index.ts
git commit -m "feat: Background-Refresh als repeatable Job"
```

---

### Task 10: Admin-Routen (CRUD)

**Files:**
- Modify: `src/api/index.ts`

Die API hat keine HTTP-Tests (Haus-Stand) — Verifikation über Typecheck und manuelle curl-Probe in Task 12.

- [ ] **Step 1: Admin-Guard-Helfer extrahieren**

Der Admin-Check ist in `src/api/index.ts` bereits zweimal dupliziert und kommt jetzt fünfmal vor — Helfer einführen. Nach `const app = Fastify(...)` / dem `declare module`-Block:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";

// Admin-Guard (App-Secret, CONTEXT.md): true = durchgelassen, sonst ist die Reply schon gesendet.
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const adminKey = request.headers["x-admin-key"];
  if (!config.ADMIN_KEY) {
    void reply.code(503).send({ error: "Admin API not configured" });
    return false;
  }
  if (typeof adminKey !== "string" || !safeEqual(adminKey, config.ADMIN_KEY)) {
    void reply.code(401).send({ error: "Invalid admin key" });
    return false;
  }
  return true;
}
```

Die beiden bestehenden Inline-Checks in `POST /admin/consumers` und `GET /admin/jobs` durch

```ts
  if (!requireAdmin(request, reply)) return;
```

ersetzen (die Import-Zeile für `FastifyReply`/`FastifyRequest` gehört nach oben zu den Imports).

- [ ] **Step 2: Credential-CRUD-Routen**

Imports oben ergänzen:

```ts
import {
  CREDENTIAL_NAME_PATTERN,
  deleteCredential,
  listCredentials,
  upsertCredential,
} from "../credentials/store.js";
```

Routen nach `GET /admin/jobs` einfügen:

```ts
// Credential Store (ADR-0002): nur apikey wird direkt angelegt, OAuth läuft über Connect-Flow.
app.post<{ Body: { name: string; provider: string; data: Record<string, unknown> } }>(
  "/admin/credentials",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    if (!config.CREDENTIAL_MASTER_KEY) return reply.code(503).send({ error: "Credential store not configured" });
    const { name, provider, data } = request.body ?? {};
    if (provider !== "apikey") {
      return reply.code(422).send({ error: "Only provider 'apikey' can be created directly — use the connect flow" });
    }
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length === 0) {
      return reply.code(422).send({ error: "data must be a non-empty object" });
    }
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name,
      provider: "apikey",
      data,
      tokenExpiresAt: null,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${name}` });
    // Nie Klartext in der Response (Spec).
    return reply.code(201).send({ name, provider: "apikey" });
  },
);

app.get("/admin/credentials", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const credentials = await listCredentials(db);
  return { credentials, count: credentials.length };
});

app.delete<{ Params: { name: string } }>("/admin/credentials/:name", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const removed = await deleteCredential(db, request.params.name);
  if (!removed) return reply.code(404).send({ error: "Credential not found" });
  return reply.code(204).send();
});
```

- [ ] **Step 3: Typecheck + Tests**

Run: `npm run typecheck && npm test`
Expected: grün

- [ ] **Step 4: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: Admin-CRUD für Credentials"
```

---

### Task 11: Connect- und Callback-Routen

**Files:**
- Modify: `src/api/index.ts`

- [ ] **Step 1: Auth-Hook-Skip erweitern**

Im `onRequest`-Hook die Skip-Zeile ändern — aus

```ts
  if (request.url === "/health" || request.url.startsWith("/admin/") || request.url.startsWith("/files/")) return;
```

wird

```ts
  // /files: HMAC-Signatur (Temp-URL). /credentials/callback: OAuth-State (single-use, Redis).
  if (
    request.url === "/health" ||
    request.url.startsWith("/admin/") ||
    request.url.startsWith("/files/") ||
    request.url.startsWith("/credentials/callback/")
  )
    return;
```

- [ ] **Step 2: Connect- und Callback-Routen**

Imports ergänzen:

```ts
import { consumeState, createState } from "../credentials/state.js";
import * as google from "../credentials/providers/google.js";
import * as shopify from "../credentials/providers/shopify.js";
```

Routen nach den Credential-CRUD-Routen einfügen:

```ts
// OAuth-Connect (Spec): Admin startet, bekommt authUrl, klickt Consent selbst durch.
// State liegt single-use in Redis; der Callback ist öffentlich, aber nur mit State nutzbar.
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function oauthRedirectUri(provider: "google" | "shopify"): string | null {
  return config.PUBLIC_BASE_URL ? `${config.PUBLIC_BASE_URL}/credentials/callback/${provider}` : null;
}

app.post<{ Body: { name: string; scopes: string[] } }>(
  "/admin/credentials/google/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Google OAuth not configured" });
    }
    const { name, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    const state = await createState(redis, { name, provider: "google", scopes });
    const authUrl = google.buildAuthUrl({ clientId: config.GOOGLE_CLIENT_ID, redirectUri, scopes, state });
    return { authUrl };
  },
);

app.post<{ Body: { name: string; shop: string; scopes: string[] } }>(
  "/admin/credentials/shopify/connect",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const redirectUri = oauthRedirectUri("shopify");
    if (!config.CREDENTIAL_MASTER_KEY || !config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Shopify OAuth not configured" });
    }
    const { name, shop, scopes } = request.body ?? {};
    if (typeof name !== "string" || !CREDENTIAL_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof shop !== "string" || !SHOP_PATTERN.test(shop)) {
      return reply.code(422).send({ error: "Invalid shop: expected <shop>.myshopify.com" });
    }
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === "string")) {
      return reply.code(422).send({ error: "scopes[] required" });
    }
    const state = await createState(redis, { name, provider: "shopify", shop });
    const authUrl = shopify.buildAuthUrl({ clientId: config.SHOPIFY_CLIENT_ID, shop, scopes, redirectUri, state });
    return { authUrl };
  },
);

app.get<{ Querystring: { code?: string; state?: string } }>(
  "/credentials/callback/google",
  async (request, reply) => {
    const redirectUri = oauthRedirectUri("google");
    if (!config.CREDENTIAL_MASTER_KEY || !config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !redirectUri) {
      return reply.code(503).send({ error: "Google OAuth not configured" });
    }
    const { code, state } = request.query;
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "google") {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    const tokens = await google.exchangeCode({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      redirectUri,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "google",
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scopes: tokens.scopes },
      tokenExpiresAt: tokens.expiresAt,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (google) verbunden. Fenster kann geschlossen werden.`);
  },
);

app.get<{ Querystring: Record<string, string | undefined> }>(
  "/credentials/callback/shopify",
  async (request, reply) => {
    if (!config.CREDENTIAL_MASTER_KEY || !config.SHOPIFY_CLIENT_ID || !config.SHOPIFY_CLIENT_SECRET) {
      return reply.code(503).send({ error: "Shopify OAuth not configured" });
    }
    const { code, state, shop } = request.query;
    if (!shopify.verifyCallbackHmac(request.query, config.SHOPIFY_CLIENT_SECRET)) {
      return reply.code(403).send({ error: "Invalid HMAC" });
    }
    const payload = state ? await consumeState(redis, state) : null;
    if (!code || !payload || payload.provider !== "shopify" || payload.shop !== shop) {
      return reply.code(403).send({ error: "Invalid or expired state" });
    }
    const tokens = await shopify.exchangeCode({
      shop: payload.shop!,
      clientId: config.SHOPIFY_CLIENT_ID,
      clientSecret: config.SHOPIFY_CLIENT_SECRET,
      code,
    });
    const ok = await upsertCredential(db, config.CREDENTIAL_MASTER_KEY, {
      name: payload.name,
      provider: "shopify",
      data: { shop: tokens.shop, accessToken: tokens.accessToken },
      tokenExpiresAt: null,
    });
    if (!ok) return reply.code(409).send({ error: `Name already used by another provider: ${payload.name}` });
    return reply.type("text/plain").send(`Credential '${payload.name}' (shopify) verbunden. Fenster kann geschlossen werden.`);
  },
);
```

- [ ] **Step 3: Typecheck + Tests**

Run: `npm run typecheck && npm test`
Expected: grün

- [ ] **Step 4: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: OAuth-Connect- und Callback-Routen"
```

---

### Task 12: End-to-End-Probe lokal + Doku

**Files:**
- Modify: `README.md`
- Modify: `.env` (lokal, nicht committen)

- [ ] **Step 1: Lokale Probe — Store ohne OAuth**

`.env` ergänzen (Key generieren):

```bash
echo "CREDENTIAL_MASTER_KEY=$(openssl rand -base64 32)" >> .env
```

API starten (`npm run dev:infra && npm run dev:api`), dann:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env | cut -d= -f2)
# apikey-Credential anlegen
curl -s -X POST localhost:5001/admin/credentials \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"supabase-test","provider":"apikey","data":{"serviceKey":"sk-123"}}'
# Liste — keine Secrets sichtbar
curl -s localhost:5001/admin/credentials -H "x-admin-key: $ADMIN_KEY"
# Löschen
curl -s -X DELETE localhost:5001/admin/credentials/supabase-test -H "x-admin-key: $ADMIN_KEY" -i
```

Expected: 201 mit `{name, provider}` (kein `data`), Liste zeigt `name/provider/status/token_expires_at`, DELETE 204. In Postgres prüfen, dass `data_encrypted` bytea ist: `select name, provider, octet_length(data_encrypted) from credential;` vor dem Löschen.

- [ ] **Step 2: Lokale Probe — Connect-Flow-Anfang (ohne echte Google-Creds)**

```bash
curl -s -X POST localhost:5001/admin/credentials/google/connect \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"name":"google-test","scopes":["https://www.googleapis.com/auth/drive"]}'
```

Expected: 503 `Google OAuth not configured` solange `GOOGLE_CLIENT_ID/SECRET` fehlen — sauberes Degradieren. Mit gesetzten Test-Werten plus `PUBLIC_BASE_URL=http://localhost:5001`: 200 mit `authUrl` auf `accounts.google.com`.

Callback-Probe ohne State:

```bash
curl -s "localhost:5001/credentials/callback/google?code=x&state=invalid" -i
```

Expected: 403 `Invalid or expired state` (und kein 401 — Route läuft am API-Key-Hook vorbei).

- [ ] **Step 3: README ergänzen**

Im Betriebs-/Env-Abschnitt der README (dort wo `ADMIN_KEY`/`URL_SIGNING_SECRET` dokumentiert sind) ergänzen:

```markdown
### Credential Store (ADR-0002)

Verschlüsselte Drittdienst-Zugänge in Postgres, referenziert per Name-Slug im Job-Payload.

| Env | Zweck |
|---|---|
| `CREDENTIAL_MASTER_KEY` | 32 Byte base64 (`openssl rand -base64 32`); ohne Wert ist der Store deaktiviert |
| `GOOGLE_CLIENT_ID/SECRET` | Google-OAuth-App (Redirect-URI: `<PUBLIC_BASE_URL>/credentials/callback/google`) |
| `SHOPIFY_CLIENT_ID/SECRET` | Shopify-App (Redirect-URI: `<PUBLIC_BASE_URL>/credentials/callback/shopify`) |

Endpoints (Admin: `x-admin-key`):

- `POST /admin/credentials` — apikey-Credential anlegen (`{name, provider: "apikey", data}`)
- `GET /admin/credentials` — Liste ohne Secrets
- `DELETE /admin/credentials/:name`
- `POST /admin/credentials/google/connect` (`{name, scopes[]}`) bzw. `.../shopify/connect` (`{name, shop, scopes[]}`) — liefert `authUrl`, Consent im Browser durchklicken
- `GET /credentials/callback/<provider>` — öffentlich, durch single-use State geschützt

OAuth-Tokens werden lazy beim Lesen refresht (Row-Lock) plus alle 30 min proaktiv
(`credentials.refresh`, Horizont 45 min). Schlägt ein Refresh fehl, steht das Credential
auf `reauth_required` — Connect-Flow erneut durchlaufen.
```

- [ ] **Step 4: Alles grün + Commit**

Run: `npm run typecheck && npm test`
Expected: grün

```bash
git add README.md
git commit -m "docs: Credential Store in README"
```

---

## Out of scope (Spec)

Master-Key-Rotation, Credential-Scoping pro Consumer, Soft-Delete/Audit-Log, weitere Provider (Supabase läuft als apikey).
