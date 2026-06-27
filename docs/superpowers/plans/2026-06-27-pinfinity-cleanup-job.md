# Pinfinity-Cleanup-Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Erster Pinfinity-Job auf der MQ-Plattform - `pinfinity.cleanup-published-images` löst die gleichnamige Supabase Edge Function ab und etabliert das Supabase-Client-Fundament für alle künftigen Pinfinity-Jobs.

**Architecture:** Ein wiederverwendbarer Helper baut aus einer `apikey`-Credential (`{ url, serviceRoleKey }`) einen service-role-`@supabase/supabase-js`-Client. Der Job kapselt seine Logik in zwei Schichten: eine rein orchestrierende, gegen einen 3-Methoden-Seam (`CleanupClient`) voll unit-getestete Funktion, und einen dünnen Adapter, der diesen Seam mit den echten fluent-supabase-js-Calls erfüllt (live verifiziert). Registrierung als Job-Typ auf der `integrations`-Queue; getriggert über einen nativen Schedule (ADR-0008).

**Tech Stack:** TypeScript (ESM, Node >=24), `@supabase/supabase-js` v2, Zod 4, BullMQ 5, Vitest 4.

## Global Constraints

- **Sprache/Doku:** Kommentare auf Deutsch, echte Umlaute (ä/ö/ü/ß), keine ae/oe/ue/ss-Ersetzung. Nur einzelne Bindestriche, keine Em-Dashes (—).
- **ESM-Imports:** Lokale Imports immer mit `.js`-Endung (auch für `.ts`-Quellen) - Projekt ist `"type": "module"`.
- **Test-Stil:** Unit-Tests mit In-Memory-Fakes (kein echtes Supabase/Redis im Test), wie `src/credentials/store.test.ts` und `src/schedules/store.test.ts`. Echtes End-to-End nur manuell (Task 4).
- **Dependency:** `@supabase/supabase-js` `^2.49.0` (passend zu Pinfinity).
- **Job-Registry-Muster:** `registerJobType({ name, queue, payloadSchema, process })` aus `src/jobs/registry.js`; `process(payload, ctx)` bekommt `ctx.getCredential(name)` und `ctx.db`. Job per Seiteneffekt-Import in Worker und API einbinden (wie `import "../jobs/media.js"`).
- **Konstanten hart** (identisch zur Edge Function, YAGNI): 7 Tage, limit 100, Bucket `pin-images`.
- **Scope (YAGNI):** Nur dieser eine Job-Typ + der `createSupabaseClient`-Helper. Keine generische Pinfinity-Basis, keine konfigurierbaren Konstanten, kein FlowProducer, keine Archivierung gescheduelter Läufe.

---

### Task 1: Supabase-Client-Helper

Wiederverwendbares Fundament: baut aus einer Store-Credential einen validierten service-role-Client. Neue Dependency.

**Files:**
- Modify: `package.json` (Dependency `@supabase/supabase-js`)
- Create: `src/integrations/supabase.ts`
- Test: `src/integrations/supabase.test.ts`

**Interfaces:**
- Consumes: nichts (erste Task).
- Produces:
  - `supabaseCredsSchema: z.ZodType<{ url: string; serviceRoleKey: string }>`
  - `type SupabaseCreds = { url: string; serviceRoleKey: string }`
  - `createSupabaseClient(creds: unknown): SupabaseClient` - wirft (Zod) bei ungültiger Cred-Form.

- [ ] **Step 1: Dependency installieren**

Run: `npm install @supabase/supabase-js@^2.49.0`
Expected: `package.json` und `package-lock.json` aktualisiert, Eintrag unter `dependencies`.

- [ ] **Step 2: Failing Test schreiben**

Create `src/integrations/supabase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSupabaseClient } from "./supabase.js";

describe("createSupabaseClient", () => {
  it("wirft bei fehlender url", () => {
    expect(() => createSupabaseClient({ serviceRoleKey: "k" })).toThrow();
  });

  it("wirft bei leerem serviceRoleKey", () => {
    expect(() => createSupabaseClient({ url: "https://x.supabase.co", serviceRoleKey: "" })).toThrow();
  });

  it("wirft bei nicht-url", () => {
    expect(() => createSupabaseClient({ url: "kein-url", serviceRoleKey: "k" })).toThrow();
  });

  it("liefert einen client bei gültigen creds", () => {
    const client = createSupabaseClient({ url: "https://x.supabase.co", serviceRoleKey: "k" });
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
  });
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/integrations/supabase.test.ts`
Expected: FAIL - `./supabase.js` existiert nicht.

- [ ] **Step 4: Helper implementieren**

Create `src/integrations/supabase.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Erwartete Form einer Supabase-apikey-Credential im Store (ADR-0009).
export const supabaseCredsSchema = z.object({
  url: z.string().url(),
  serviceRoleKey: z.string().min(1),
});

export type SupabaseCreds = z.infer<typeof supabaseCredsSchema>;

// Baut einen service-role-Client aus einer Store-Credential. Validiert die Cred-Form,
// damit eine Fehlkonfiguration eine klare Meldung wirft statt eines obskuren SDK-Fehlers.
// Server-Kontext: keine Session-Persistenz, kein Auto-Refresh.
export function createSupabaseClient(creds: unknown): SupabaseClient {
  const parsed = supabaseCredsSchema.parse(creds);
  return createClient(parsed.url, parsed.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/integrations/supabase.test.ts`
Expected: PASS (4 Tests grün).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/integrations/supabase.ts src/integrations/supabase.test.ts
git commit -m "feat: Supabase-Service-Role-Client-Helper"
```

---

### Task 2: Cleanup-Orchestrierung

Die rein orchestrierende Logik des Cleanups gegen einen minimalen 3-Methoden-Seam - voll unit-getestet, ohne echtes Supabase. Der Job-Typ selbst wird erst in Task 3 registriert.

**Files:**
- Create: `src/jobs/pinfinity/cleanup.ts`
- Test: `src/jobs/pinfinity/cleanup.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `interface CleanablePin { id: string; image_path: string }`
  - `interface CleanupClient { listCleanablePins(olderThanDays: number, limit: number): Promise<CleanablePin[]>; removeImages(bucket: string, paths: string[]): Promise<{ error: string | null }>; nullImagePaths(ids: string[]): Promise<{ error: string | null }> }`
  - `interface CleanupResult { total: number; cleaned: number; failed: number; dryRun: boolean }`
  - `cleanupPublishedImages(client: CleanupClient, opts: { dryRun: boolean }): Promise<CleanupResult>`
  - Konstanten `OLDER_THAN_DAYS = 7`, `LIMIT = 100`, `BUCKET = "pin-images"` (modul-intern, nicht exportiert).

- [ ] **Step 1: Failing Test schreiben**

Create `src/jobs/pinfinity/cleanup.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { cleanupPublishedImages, type CleanablePin, type CleanupClient } from "./cleanup.js";

function fakeClient(
  pins: CleanablePin[],
  opts: { removeError?: string; updateError?: string } = {},
): { client: CleanupClient; remove: ReturnType<typeof vi.fn>; nullPaths: ReturnType<typeof vi.fn> } {
  const remove = vi.fn(async () => ({ error: opts.removeError ?? null }));
  const nullPaths = vi.fn(async () => ({ error: opts.updateError ?? null }));
  const client: CleanupClient = {
    listCleanablePins: async () => pins,
    removeImages: remove,
    nullImagePaths: nullPaths,
  };
  return { client, remove, nullPaths };
}

const twoPins: CleanablePin[] = [
  { id: "p1", image_path: "a/1.jpg" },
  { id: "p2", image_path: "b/2.jpg" },
];

describe("cleanupPublishedImages", () => {
  it("keine pins: cleaned 0, storage nie gerufen", async () => {
    const { client, remove } = fakeClient([]);
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 0, cleaned: 0, failed: 0, dryRun: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("erfolgspfad: bilder entfernt und pfade genullt", async () => {
    const { client, remove, nullPaths } = fakeClient(twoPins);
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 2, failed: 0, dryRun: false });
    expect(remove).toHaveBeenCalledWith("pin-images", ["a/1.jpg", "b/2.jpg"]);
    expect(nullPaths).toHaveBeenCalledWith(["p1", "p2"]);
  });

  it("storage-fehler: failed, kein db-update", async () => {
    const { client, nullPaths } = fakeClient(twoPins, { removeError: "boom" });
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 2, dryRun: false });
    expect(nullPaths).not.toHaveBeenCalled();
  });

  it("db-update-fehler: failed", async () => {
    const { client } = fakeClient(twoPins, { updateError: "nope" });
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 2, dryRun: false });
  });

  it("dryRun: nichts gelöscht, nichts genullt", async () => {
    const { client, remove, nullPaths } = fakeClient(twoPins);
    const result = await cleanupPublishedImages(client, { dryRun: true });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 0, dryRun: true });
    expect(remove).not.toHaveBeenCalled();
    expect(nullPaths).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/jobs/pinfinity/cleanup.test.ts`
Expected: FAIL - `./cleanup.js` existiert nicht.

- [ ] **Step 3: Orchestrierung implementieren**

Create `src/jobs/pinfinity/cleanup.ts`:

```ts
// Pinfinity-Cleanup (Tracer der Pinfinity-Migration): löst die Edge Function
// cleanup-published-images ab. Loescht Bild-Dateien laengst veroeffentlichter Pins
// aus Pinfinitys Supabase Storage und nullt deren image_path.
// Die Orchestrierung hier ist rein und gegen den CleanupClient-Seam testbar;
// der Adapter auf das echte supabase-js folgt in derselben Datei (Task 3).

const OLDER_THAN_DAYS = 7;
const LIMIT = 100;
const BUCKET = "pin-images";

export interface CleanablePin {
  id: string;
  image_path: string;
}

// Schmaler Seam auf Pinfinitys Supabase: drei High-Level-Operationen statt der
// fluent supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface CleanupClient {
  listCleanablePins(olderThanDays: number, limit: number): Promise<CleanablePin[]>;
  removeImages(bucket: string, paths: string[]): Promise<{ error: string | null }>;
  nullImagePaths(ids: string[]): Promise<{ error: string | null }>;
}

export interface CleanupResult {
  total: number;
  cleaned: number;
  failed: number;
  dryRun: boolean;
}

export async function cleanupPublishedImages(
  client: CleanupClient,
  opts: { dryRun: boolean },
): Promise<CleanupResult> {
  const pins = await client.listCleanablePins(OLDER_THAN_DAYS, LIMIT);
  const total = pins.length;
  if (total === 0) return { total: 0, cleaned: 0, failed: 0, dryRun: opts.dryRun };
  if (opts.dryRun) return { total, cleaned: 0, failed: 0, dryRun: true };

  const removed = await client.removeImages(
    BUCKET,
    pins.map((p) => p.image_path),
  );
  if (removed.error) return { total, cleaned: 0, failed: total, dryRun: false };

  const updated = await client.nullImagePaths(pins.map((p) => p.id));
  if (updated.error) return { total, cleaned: 0, failed: total, dryRun: false };

  return { total, cleaned: total, failed: 0, dryRun: false };
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/jobs/pinfinity/cleanup.test.ts`
Expected: PASS (5 Tests grün).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/pinfinity/cleanup.ts src/jobs/pinfinity/cleanup.test.ts
git commit -m "feat: Cleanup-Orchestrierung gegen CleanupClient-Seam"
```

---

### Task 3: Supabase-Adapter + Job-Typ-Registrierung + Verdrahtung

Erfüllt den `CleanupClient`-Seam mit den echten fluent-supabase-js-Calls, registriert den Job-Typ und bindet ihn in Worker und API ein.

**Files:**
- Modify: `src/jobs/pinfinity/cleanup.ts` (Adapter + `registerJobType` ergänzen)
- Modify: `src/worker/index.ts` (Seiteneffekt-Import)
- Modify: `src/api/index.ts` (Seiteneffekt-Import)

**Interfaces:**
- Consumes:
  - aus dieser Datei: `cleanupPublishedImages`, `CleanupClient`, `CleanablePin`.
  - aus `../../integrations/supabase.js`: `createSupabaseClient`.
  - aus `../registry.js`: `registerJobType` (Signatur `registerJobType({ name, queue, payloadSchema, process })`; `process(payload, ctx)` mit `ctx.getCredential(name): Promise<Record<string, unknown>>`).
- Produces:
  - `supabaseCleanupClient(sb: SupabaseClient): CleanupClient`
  - Registrierter Job-Typ `pinfinity.cleanup-published-images` (Queue `integrations`, Payload `{ supabaseCredential: string; dryRun?: boolean }`).

- [ ] **Step 1: Adapter + Registrierung an cleanup.ts anhängen**

Oben in `src/jobs/pinfinity/cleanup.ts` die Importe ergänzen (über die Konstanten setzen):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";
```

Am Ende der Datei (nach `cleanupPublishedImages`) anfügen:

```ts
// Adapter: erfüllt den CleanupClient-Seam mit den echten supabase-js-Calls.
// Duenn gehalten und ueber das Live-E2E (Task 4) verifiziert, nicht per Unit-Test.
export function supabaseCleanupClient(sb: SupabaseClient): CleanupClient {
  return {
    async listCleanablePins(olderThanDays, limit) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
      const { data, error } = await sb
        .from("pins")
        .select("id, image_path")
        .not("pinterest_pin_id", "is", null)
        .not("image_path", "is", null)
        .lt("published_at", cutoff)
        .limit(limit);
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      return (data ?? []) as CleanablePin[];
    },
    async removeImages(bucket, paths) {
      const { error } = await sb.storage.from(bucket).remove(paths);
      return { error: error ? error.message : null };
    },
    async nullImagePaths(ids) {
      const { error } = await sb.from("pins").update({ image_path: null }).in("id", ids);
      return { error: error ? error.message : null };
    },
  };
}

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  dryRun: z.boolean().default(false),
});

registerJobType({
  name: "pinfinity.cleanup-published-images",
  queue: "integrations",
  payloadSchema,
  process: async (payload, ctx) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    return cleanupPublishedImages(supabaseCleanupClient(sb), { dryRun: payload.dryRun });
  },
});
```

- [ ] **Step 2: Worker-Import ergänzen**

In `src/worker/index.ts` bei den bestehenden Job-Importen (nach `import "../jobs/media.js";`) ergänzen:

```ts
import "../jobs/pinfinity/cleanup.js";
```

- [ ] **Step 3: API-Import ergänzen**

In `src/api/index.ts` bei den bestehenden Job-Importen (nach `import "../jobs/credentials-refresh.js";`) ergänzen:

```ts
import "../jobs/pinfinity/cleanup.js";
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 5: Volle Suite laufen lassen (keine Regression, Job registriert sich konfliktfrei)**

Run: `npm test`
Expected: alle Tests grün (inkl. der neuen Supabase- und Cleanup-Tests). Kein `Job type already registered`-Fehler.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/pinfinity/cleanup.ts src/worker/index.ts src/api/index.ts
git commit -m "feat: pinfinity.cleanup-published-images Job-Typ registriert und verdrahtet"
```

---

### Task 4: Doku + Live-E2E-Verfahren

README um den neuen Job-Typ ergänzen und das (vom Betreiber auszuführende) Live-E2E-Verfahren dokumentieren. Die echte Verifikation gegen Petras Supabase braucht deren service-role-Key und läuft daher beim Betreiber, nicht im Implementierungslauf.

**Files:**
- Modify: `README.md` (Job-Typen-Liste + kurzer Pinfinity-Hinweis)

- [ ] **Step 1: Volle Suite + Typecheck als Gate**

Run: `npm test && npm run typecheck`
Expected: alle Tests grün, keine TS-Fehler.

- [ ] **Step 2: README - Job-Typen-Liste ergänzen**

In `README.md` die `**Job-Typen**`-Zeile um den neuen Typ erweitern. Aus:

```md
**Job-Typen**: `integrations.ping` (Smoke-Test), `media.extract-audio` (MP3, Legacy-Defaults 128k/22.05kHz), `media.thumbnail` (JPEG/PNG-Frame). Registry: `src/jobs/`.
```

wird:

```md
**Job-Typen**: `integrations.ping` (Smoke-Test), `media.extract-audio` (MP3, Legacy-Defaults 128k/22.05kHz), `media.thumbnail` (JPEG/PNG-Frame), `pinfinity.cleanup-published-images` (löscht Bilder längst veröffentlichter Pins aus Pinfinitys Supabase Storage; Payload `{ supabaseCredential, dryRun? }`). Registry: `src/jobs/`.
```

- [ ] **Step 3: README - Pinfinity-Betriebshinweis ergänzen**

In `README.md` im Abschnitt "Offen" die Pinfinity-Zeile so anpassen, dass der Cleanup-Job als erledigt markiert ist und das Betriebsverfahren benannt wird. Ersetze den Satzteil `Pinfinity-Migration: Job-Typen ... setzen` durch:

```md
Pinfinity-Migration läuft: `pinfinity.cleanup-published-images` steht (erster Tracer). Betrieb: `pinfinity-supabase`-Credential (`POST /admin/credentials`, `{name, provider:"apikey", data:{url, serviceRoleKey}}`) und Schedule (`POST /admin/schedules`, `payload:{supabaseCredential, dryRun}`) anlegen, ersten Lauf mit `dryRun:true`, dann pg_cron in Pinfinitys Supabase abdrehen. Nächste Job-Typen: `ai.generate-pin-metadata`, `pinterest.publish-pin`
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: Cleanup-Job in README, Pinfinity-Betriebsverfahren"
```

- [ ] **Step 5: Live-E2E (Betreiber, nach Merge + Deploy - nicht im Implementierungslauf)**

Dieses Verfahren ist dokumentiert, damit der Betreiber es ausführt; es braucht Petras echte Supabase-Zugänge:

1. Lokal `.env` um `CREDENTIAL_MASTER_KEY` ergänzt (falls nicht gesetzt). `npm run dev:infra`, `npm run dev:api`, `npm run dev:worker`.
2. Supabase-Credential anlegen: `POST http://localhost:5001/admin/credentials` (Header `x-admin-key`) mit `{ "name": "pinfinity-supabase", "provider": "apikey", "data": { "url": "<SUPABASE_URL>", "serviceRoleKey": "<SERVICE_ROLE_KEY>" } }`. Erwartet `201`.
3. Minütlichen dryRun-Schedule anlegen: `POST /admin/schedules` mit `{ "name": "pinfinity-cleanup-smoke", "cron": "* * * * *", "tz": "UTC", "jobType": "pinfinity.cleanup-published-images", "payload": { "supabaseCredential": "pinfinity-supabase", "dryRun": true }, "consumer": "pinfinity" }`. Erwartet `201`.
4. Worker-Log beobachten: innerhalb ~60s ein `{"event":"completed","queue":"integrations","type":"pinfinity.cleanup-published-images"}`; in Bull Board (`npm run dev:board`, Port 5002) zeigt der Job-Returnvalue `{ total, cleaned: 0, failed: 0, dryRun: true }`. Beweist Schedule → Job → Supabase-Read ohne Löschung.
5. Schedule löschen (`DELETE /admin/schedules/pinfinity-cleanup-smoke`). Auf Prod später einen echten täglichen Schedule mit `dryRun:false` anlegen.

---

## Self-Review

**Spec coverage** (gegen `docs/superpowers/specs/2026-06-27-pinfinity-cleanup-job-design.md`):
- `createSupabaseClient` + Zod-Cred-Validierung + Dependency → Task 1 ✓
- Job-Typ `pinfinity.cleanup-published-images`, Queue `integrations`, Payload `{ supabaseCredential, dryRun? }` → Task 3 ✓
- Verhalten (Query alte publizierte Pins, dryRun, Storage-remove, image_path nullen, Storage-Fehler best-effort ohne Wurf) → Task 2 (Orchestrierung) + Task 3 (Adapter-Query/Storage/Update) ✓
- Konstanten 7 Tage / 100 / `pin-images` hart → Task 2 ✓
- Fehlerbehandlung (Cred ungültig wirft; Query wirft; Storage/Update best-effort) → Task 1 (Zod-Wurf), Task 3 (Query-Wurf), Task 2 (failed-Zähler) ✓
- Tests gegen Fakes (createSupabaseClient + cleanupPublishedImages-Branches) → Task 1 + Task 2 ✓
- Verdrahtung Worker + API → Task 3 ✓
- Betrieb + Live-E2E (dryRun zuerst) → Task 4 ✓
- Scope-Grenzen (ein Job, keine generische Basis, keine konfigurierbaren Konstanten) → eingehalten ✓

**Placeholder-Scan:** Kein TBD/TODO; jeder Code-Step enthält vollständigen Code, jeder Run-Step ein erwartetes Ergebnis. `<SUPABASE_URL>`/`<SERVICE_ROLE_KEY>` in Task 4 Step 5 sind bewusste Betreiber-Platzhalter (Live-Secrets, nicht im Repo).

**Type-Konsistenz:** `CleanablePin`/`CleanupClient`/`CleanupResult` (Task 2) werden in Task 3 unverändert konsumiert; `cleanupPublishedImages(client, { dryRun })`-Signatur identisch zwischen Task 2 (Definition + Test) und Task 3 (Aufruf im `process`); `createSupabaseClient(creds: unknown)` (Task 1) passt zu `ctx.getCredential(...): Promise<Record<string, unknown>>` (Task 3); `supabaseCleanupClient(sb): CleanupClient` erfüllt exakt den in Task 2 definierten Seam; Job-Name `pinfinity.cleanup-published-images` und Queue `integrations` konsistent zwischen Task 3 (Registrierung), Task 4 (README + E2E-Payload). ✓
