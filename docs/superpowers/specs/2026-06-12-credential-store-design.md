# Credential Store — Design

Datum: 2026-06-12 · Basis: ADR-0002 (eigener Credential Store statt Vault)

## Ziel

Verschlüsselte Ablage von Drittdienst-Zugängen (Credentials) in Postgres mit zentralem OAuth-Token-Refresh. v1 unterstützt drei Provider: Google OAuth, Shopify OAuth, statische API-Keys. Jobs referenzieren Credentials per sprechendem Namen; Klartext-Zugänge verlassen nie den Worker und landen nie im Payload oder Job-Archiv.

## Entscheidungen (aus Brainstorming)

- **Scope v1**: Google OAuth + Shopify OAuth + statische API-Keys
- **Connect-Flow**: Admin-initiiert (x-admin-key), Consent klickt der Admin selbst durch
- **Refresh**: Lazy beim Lesen (Korrektheit) plus Background-Job (Optimierung)
- **Referenzierung**: sprechender Name-Slug (z.B. `google-wachmacherei`), UUID nur interner PK
- **Zugriffskontrolle**: kein Credential-Scoping in v1; Queue-Scopes reichen, Consumer sehen nie Klartext
- **Architektur**: ein Modul `src/credentials/`, eine Tabelle, Provider-Strategie (Ansatz A)
- **Key-Rotation**: bewusst out of scope v1

## Datenmodell

Migration `credential` (node-pg-migrate, bestehendes Muster):

| Spalte | Typ | Bemerkung |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `name` | text unique not null | Slug `^[a-z0-9][a-z0-9-]{0,63}$` (gleiche Regel wie tenant) |
| `provider` | text not null | `'google'` \| `'shopify'` \| `'apikey'` |
| `data_encrypted` | bytea not null | `iv (12B) || authTag (16B) || ciphertext` |
| `token_expires_at` | timestamptz | null bei apikey und Shopify |
| `status` | text not null default `'ok'` | `'ok'` \| `'reauth_required'` |
| `created_at` / `updated_at` | timestamptz | |

Klartext (vor Verschlüsselung) ist JSON, Form pro Provider:

- Google: `{ accessToken, refreshToken, scopes }`
- Shopify: `{ shop, accessToken }`
- apikey: beliebiges Key-Value-Objekt

## Verschlüsselung (`src/credentials/crypto.ts`)

- AES-256-GCM, Master-Key aus Env `CREDENTIAL_MASTER_KEY` (32 Byte, base64)
- Zufälliger 12-Byte-IV pro Verschlüsselungsvorgang
- AAD = Credential-Name: bindet Ciphertext an die Zeile, verhindert Blob-Tausch zwischen Zeilen
- Entschlüsselung mit falschem Key oder vertauschtem Namen schlägt hart fehl (GCM-Auth-Tag)

## Endpoints

Admin-Routen (hinter `x-admin-key`, bestehendes Muster in `src/api/index.ts`):

- `POST /admin/credentials` — apikey-Credential anlegen: `{name, provider: 'apikey', data}` → 201 `{id, name, provider}`. Nie Klartext in der Response.
- `GET /admin/credentials` — Liste: `name, provider, status, token_expires_at`. Keine Secrets.
- `DELETE /admin/credentials/:name` — hartes Löschen (kein Soft-Delete v1).
- `POST /admin/credentials/google/connect` — `{name, scopes[]}` → `{authUrl}`. Auth-URL mit `access_type=offline&prompt=consent` (erzwingt Refresh-Token).
- `POST /admin/credentials/shopify/connect` — `{name, shop}` → `{authUrl}`.

Callback-Routen (öffentlich, durch State geschützt; Auth-Hook bekommt `/credentials/callback/` als Skip wie `/files/`):

- `GET /credentials/callback/google?code&state` — State validieren, Code-Exchange, Tokens verschlüsselt speichern (Insert oder Update bei Re-Connect, Update setzt `status = 'ok'` zurück), schlichte Text-Bestätigung.
- `GET /credentials/callback/shopify?code&state&shop&hmac` — zusätzlich Shopify-HMAC-Prüfung.

State-Handling: zufälliger State (32 Byte hex) in Redis, `setex` 10 min, Value `{name, provider, scopes|shop}`. Callback löscht State nach Gebrauch (single-use).

## Refresh-Logik (`src/credentials/store.ts`)

`getCredential(db, name)` — einzige Lese-Funktion für Worker:

1. `select … for update` in Transaktion. Row-Lock verhindert parallele Refreshes; zweiter Worker wartet und sieht das frische Token.
2. `status = 'reauth_required'` → sofort Fehler, kein Refresh-Versuch.
3. `token_expires_at` null oder mehr als 60 s in der Zukunft → entschlüsseln, zurückgeben.
4. Sonst Provider-Refresh (`providers/google.ts`; Shopify-Tokens laufen nicht ab → no-op). Neues Token verschlüsselt speichern, `token_expires_at` aktualisieren, commit.
5. Refresh-Fehler (z.B. Refresh-Token widerrufen) → `status = 'reauth_required'` setzen, Fehler werfen → Job failt mit klarer Meldung.

## Background-Refresh

Repeatable Job `credentials.refresh` nach Cleanup-Muster (`src/jobs/cleanup.ts`), alle 30 min. Refresht alle Google-Credentials mit `token_expires_at < now() + 45 min` und `status = 'ok'`. Nutzt denselben `getCredential`-Pfad — keine zweite Refresh-Implementierung.

## Worker-Integration

Job-Typen mit Credential-Bedarf deklarieren im Zod-Payload-Schema `credential: z.string()` (Slug). Der Processor ruft `getCredential` auf. Klartext erscheint nie im Payload, nie im Job-Archiv, nie in Callbacks.

## Konfiguration

Neue Env-Variablen, alle optional — Feature degradiert sauber (503 wie bei fehlendem `ADMIN_KEY`):

- `CREDENTIAL_MASTER_KEY` — 32 Byte base64
- `PUBLIC_BASE_URL` — Basis für Redirect-URIs (z.B. `https://mq.weissteiner-automation.com`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`

## Tests

- `crypto.test.ts`: Roundtrip; falscher Key schlägt fehl; AAD-Mismatch (Name getauscht) schlägt fehl
- `store.test.ts`: Lazy-Refresh bei Ablauf (Provider gemockt); kein Refresh bei frischem Token; `reauth_required`-Pfad
- `providers/google.test.ts`: Auth-URL-Bau; Token-Response-Parsing (HTTP gemockt)
- Callback: State-Validierung (fehlend, abgelaufen, wiederverwendet → 403)

TDD nach Haus-Stil, bestehende Vitest-Muster.

## Out of scope v1

- Master-Key-Rotation
- Credential-Scoping pro Consumer
- Soft-Delete / Audit-Log für Credentials
- Weitere Provider (Supabase läuft als apikey)
