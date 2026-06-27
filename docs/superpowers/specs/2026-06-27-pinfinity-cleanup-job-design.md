# Pinfinity-Cleanup-Job (Tracer der Pinfinity-Migration)

## Kontext und Ziel

Erster migrierter Pinfinity-Job auf die MQ-Plattform und Tracer-Bullet für den gesamten Pinfinity-Block: dünnster vertikaler Schnitt durch alle neuen Schichten (nativer Schedule → MQ-Job → Supabase-Service-Role-Client → DB + Storage). Etabliert das Supabase-Client-Fundament, auf dem die wertvolleren Jobs (`ai.generate-pin-metadata`, `pinterest.publish-pin`) später aufsetzen.

Löst die Supabase Edge Function `cleanup-published-images` ab: löscht Bild-Dateien längst veröffentlichter Pins aus dem Supabase Storage und nullt deren `image_path`.

Niedrigste Komplexität (nur Supabase DB + Storage, kein externer Token, keine KI, kein Video, kein Rate-Limit) und kleinster Blast-Radius der drei Kandidaten - darum zuerst.

## Domänensprache

Siehe `CONTEXT.md`. Relevant: **Job**, **Job-Typ**, **Schedule** (ADR-0008), **Credential** / **Credential Store** (ADR-0002), **Consumer**, **Queue**.

Neuer Begriff implizit: ein **Pinfinity-Job** ist ein Job-Typ, dessen `process` gegen Pinfinitys eigene Supabase-Instanz arbeitet (nicht die MQ-Postgres). Tabellen-/Bucket-Namen (`pins`, `pin-images`) sind Pinfinity-spezifisch und im Job hart codiert.

## Entscheidungen (aus dem Brainstorming)

- **Zugriffsweg:** `@supabase/supabase-js` v2 SDK (neue Dependency), nicht roher pg. Grund: spätere Pinfinity-Jobs brauchen Supabase-RPC (`get_gemini_api_key`, `get_pinterest_access_token`) plus Storage - das SDK deckt DB, RPC und Storage einheitlich ab und matcht die Edge Functions 1:1.
- **Credential:** Supabase-URL und service-role-Key als `apikey`-Credential im Store (`data: { url, serviceRoleKey }`), Name z.B. `pinfinity-supabase`. Kein neuer Provider. Bestätigt ADR-0009 (App-geteilte Tokens bleiben in Supabase; MQ greift via service-role zu).
- **Cred-Referenz:** Der Job liest den Cred-Namen aus dem Payload (`supabaseCredential`), nicht hart codiert - bleibt mandantenfähig.
- **Queue:** `integrations` (kein Rate-Limit, kein neuer Queue-Bedarf laut ADR-0007).
- **dryRun:** Payload-Flag (default `false`). De-risked den destruktiven ersten Prod-Lauf und das Debugging: zählt und reportet, löscht aber nicht.

## Architektur und Komponenten

### `src/integrations/supabase.ts` (neu)

Wiederverwendbares Fundament für alle Pinfinity-Jobs.

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const supabaseCredsSchema = z.object({
  url: z.string().url(),
  serviceRoleKey: z.string().min(1),
});

export type SupabaseCreds = z.infer<typeof supabaseCredsSchema>;

// Baut einen service-role-Client aus einer Store-Credential. Validiert die Cred-Form
// (klare Fehlermeldung statt obskurem SDK-Fehler bei Fehlkonfiguration). Server-Kontext:
// keine Session-Persistenz, kein Auto-Refresh.
export function createSupabaseClient(creds: unknown): SupabaseClient {
  const parsed = supabaseCredsSchema.parse(creds);
  return createClient(parsed.url, parsed.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

Dependency: `@supabase/supabase-js` (^2.49.0, passend zu Pinfinity).

### `src/jobs/pinfinity/cleanup.ts` (neu)

Registriert den Job-Typ und kapselt die Pinfinity-Cleanup-Logik.

- Name: `pinfinity.cleanup-published-images`
- Queue: `integrations`
- `payloadSchema`: `{ supabaseCredential: string (min 1), dryRun?: boolean default false }`
- `process(payload, ctx)`:
  1. `const creds = await ctx.getCredential(payload.supabaseCredential)`
  2. `const client = createSupabaseClient(creds)`
  3. `return cleanupPublishedImages(client, { dryRun: payload.dryRun })`

Die Orchestrierung als eigene, gegen einen Client-Seam testbare Funktion:

```ts
const OLDER_THAN_DAYS = 7;
const LIMIT = 100;
const BUCKET = "pin-images";

export interface CleanupResult { total: number; cleaned: number; failed: number; dryRun: boolean }

export async function cleanupPublishedImages(
  client: CleanupClient,
  opts: { dryRun: boolean },
): Promise<CleanupResult> { /* siehe Verhalten */ }
```

`CleanupClient` ist ein minimaler struktureller Typ (die Teilmenge der supabase-js-Methoden, die der Job nutzt: `.from(table).select(...).not(...).lt(...).limit(...)`, `.storage.from(bucket).remove(paths)`, `.from(table).update(...).in(...)`). Der echte `SupabaseClient` erfüllt ihn; ein Fake im Test ebenso.

### Verdrahtung

`src/worker/index.ts` und `src/api/index.ts` importieren den Job per Seiteneffekt: `import "../jobs/pinfinity/cleanup.js"` (gleiches Muster wie `import "../jobs/media.js"`).

## Datenfluss und Verhalten

Spiegelt die Edge Function `cleanup-published-images`:

1. Query `pins`: `pinterest_pin_id is not null` UND `image_path is not null` UND `published_at < now - 7 Tage`, `limit 100`, Felder `id, image_path`.
2. Keine Treffer → `{ total: 0, cleaned: 0, failed: 0, dryRun }` zurück.
3. `dryRun === true` → `{ total: n, cleaned: 0, failed: 0, dryRun: true }` zurück (nichts gelöscht, nichts geändert).
4. sonst: `client.storage.from("pin-images").remove(imagePaths)`.
   - Storage-Fehler → `{ total: n, cleaned: 0, failed: n, dryRun: false }` (kein DB-Update; best-effort, nächster Cron-Lauf nimmt dieselben Pins erneut, da `image_path` noch gesetzt). Wirft NICHT.
   - Erfolg → `update pins set image_path = null where id in (pinIds)`.
     - DB-Update-Fehler → `{ total: n, cleaned: 0, failed: n, dryRun: false }`.
     - Erfolg → `{ total: n, cleaned: n, failed: 0, dryRun: false }`.

## Fehlerbehandlung

- Fehlende/ungültige Supabase-Credential → `createSupabaseClient` (Zod) wirft → `process` wirft → Worker loggt `failed`, Bull Board zeigt den fehlgeschlagenen Job. (Gescheduelte Läufe landen nicht im Job-Archiv - bekannte Grenze aus ADR-0008.)
- Query-Fehler (Netzwerk, RLS, falsche Keys) → wirft → Job failed.
- Storage-/Update-Fehler innerhalb eines Laufs → kein Wurf, `failed`-Zähler im Ergebnis (best-effort, selbstheilend beim nächsten Lauf).

## Konstanten

Hart codiert, identisch zur Edge Function (YAGNI; später per Payload überschreibbar, falls je nötig): `OLDER_THAN_DAYS = 7`, `LIMIT = 100`, `BUCKET = "pin-images"`.

## Tests

Haus-Stil: Unit-Tests mit In-Memory-Fakes, kein echtes Supabase im Test.

- `createSupabaseClient`: fehlende/leere `url` oder `serviceRoleKey` → wirft (Zod). Gültige Creds → liefert Client-Objekt.
- `cleanupPublishedImages(fakeClient, opts)`:
  - keine Pins → `{ total: 0, cleaned: 0, failed: 0 }`, `storage.remove` nie gerufen.
  - Erfolgspfad → `storage.remove(paths)` und `update ... in(ids)` gerufen, `cleaned = n`.
  - Storage-Fehler → `failed = n`, kein `update` gerufen.
  - DB-Update-Fehler → `failed = n`.
  - `dryRun: true` → weder `storage.remove` noch `update` gerufen, `total = n`, `cleaned = 0`.

Der Fake-Client implementiert `CleanupClient` mit einem fluent-Query-Stub, der kanonische Pins liefert, plus `storage.remove`/`update`-Spies, die Erfolg oder Fehler simulieren.

- **Live-E2E (manuell, nicht automatisiert):** Job lokal gegen Petras echte Supabase laufen lassen, zuerst `dryRun: true` (sicher, beweist Schedule→Job→Supabase-Read+Zählung), dann ein echter Lauf, Ergebnis prüfen.

## Betrieb (nach Merge + Deploy, durch den Betreiber)

1. `pinfinity-supabase`-Credential auf Prod anlegen: `POST /admin/credentials` mit `{ name: "pinfinity-supabase", provider: "apikey", data: { url, serviceRoleKey } }`.
2. Schedule anlegen: `POST /admin/schedules` mit cron (z.B. täglich), `jobType: "pinfinity.cleanup-published-images"`, `payload: { supabaseCredential: "pinfinity-supabase", dryRun: true }` für den ersten Lauf, später `dryRun` entfernen/false.
3. pg_cron-Job für Cleanup in Pinfinitys Supabase deaktivieren (Cutover).

## Scope-Grenzen (YAGNI)

- Nur dieser eine Job-Typ. Keine generische Pinfinity-Job-Basis über den `createSupabaseClient`-Helper hinaus.
- Keine Archivierung gescheduelter Läufe (bekannte ADR-0008-Grenze, separater Follow-up).
- Kein FlowProducer. Metadata- und Publish-Jobs sind spätere, eigene Specs.
- Konstanten nicht konfigurierbar.
