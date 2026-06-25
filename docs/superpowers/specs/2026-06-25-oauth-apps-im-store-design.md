# OAuth-Apps im Credential Store — Design

Datum: 2026-06-25 · Basis: [Credential Store](2026-06-12-credential-store-design.md) (ADR-0002)

## Ziel

Die OAuth-App-Zugänge (Client ID + Client Secret) für Google und Shopify nicht mehr aus dem Env lesen, sondern verschlüsselt im Credential Store ablegen. Damit lassen sich **mehrere Google-/Shopify-Apps** (verschiedene Consent-Screens) parallel verwalten. Jeder erzeugte Access-/Refresh-Token wird mit der App verknüpft, über die er autorisiert wurde, und beim Refresh über deren Client-Secret erneuert.

## Ausgangslage

Heute liegen `GOOGLE_CLIENT_ID/SECRET` und `SHOPIFY_CLIENT_ID/SECRET` im Env. Connect-, Callback- und Refresh-Pfad ziehen direkt aus `config` (`src/api/index.ts:251,262,295,304,323,336`; Worker-Refresher analog). Das erlaubt genau **eine** App pro Provider. Der Credential Store wurde nie deployt (Prod-HEAD = `c9dae3a`), daher gibt es keine Bestandsdaten zu migrieren — der Wechsel kann store-only sein, ohne Übergangs-Fallback.

## Entscheidungen (aus Brainstorming)

- **Kein neuer Key**: App-Secrets werden mit dem bestehenden `CREDENTIAL_MASTER_KEY` (AES-256-GCM, AAD=name) verschlüsselt. Ein Key für Tokens und App-Secrets.
- **Eine Tabelle**: bestehende `credential`-Tabelle erweitern (Self-FK), keine zweite Tabelle.
- **Kardinalität 1:N**: eine App → mehrere Token-Credentials. 1:1 ist Spezialfall.
- **Delete-Policy CASCADE**: App löschen entfernt alle dranhängenden Tokens.
- **Store-only**: Env-Pfad für Client-Creds fällt komplett weg, kein Fallback.
- **API**: eigener App-Endpoint zum Anlegen/Listen/Löschen; Connect referenziert App per Name.
- **Out of scope**: Key-Rotation, App-Secret-Update-UI über reines Re-Upsert hinaus.

## Datenmodell

Additive Migration auf `credential` (node-pg-migrate):

| Spalte | Typ | Bemerkung |
|---|---|---|
| `parent_credential_id` | uuid | `references credential(id) on delete cascade`, null bei App-Rows, apikey, standalone |

Provider-Check erweitern: `provider in ('google','shopify','apikey','google-app','shopify-app')`.

Rollen der Rows:

| Row-Typ | provider | data_encrypted | parent_credential_id | token_expires_at / status |
|---|---|---|---|---|
| App | `google-app` / `shopify-app` | `{client_id, client_secret}` | null | ungenutzt (status default `ok`) |
| Token | `google` / `shopify` | `{access, refresh, ...}` | `<app.id>` | wie bisher |
| API-Key | `apikey` | `{...}` | null | null |

- `name` bleibt global unique → App- und Token-Row dürfen nicht denselben Namen tragen.
- App-Rows haben keine sinnvollen `token_expires_at`/`status`-Semantik; Spalten bleiben auf Default und werden ignoriert.

## Crypto

Unverändert. App-`data_encrypted` = `encryptCredential(masterKey, name, {client_id, client_secret})`, Layout `iv(12) || authTag(16) || ciphertext`. Entschlüsselung mit AAD=name wie bei Tokens.

## Store-Funktionen (`src/credentials/store.ts`)

Neu:

- `upsertOAuthApp(pool, masterKey, {name, provider, clientId, clientSecret})` — schreibt Row mit provider `google-app`/`shopify-app`. `provider` im Input ist `google`|`shopify`, wird intern auf `-app` gemappt.
- `getOAuthApp(pool, masterKey, name)` → `{ id, provider, clientId, clientSecret }` (entschlüsselt). `id` wird im Callback für `parentCredentialId` gebraucht. Wirft, wenn nicht gefunden oder Row kein App-Provider. Genutzt von connect, callback, refresh.
- `listOAuthApps(pool)` → `{ name, provider }[]` ohne Secrets.
- `deleteOAuthApp(pool, name)` → löscht App-Row; FK-Cascade entfernt verknüpfte Tokens. Liefert `boolean` (rowCount).

Geändert:

- `upsertCredential(...)` bekommt zusätzlich `parentCredentialId: string | null` und schreibt es in die Token-Row.
- `Refresher`-Signatur wird `(data, appCreds: { clientId, clientSecret }) => Promise<{ data, expiresAt }>`.
- `getCredential(...)`: selektiert zusätzlich `parent_credential_id`. Wenn ein Refresh nötig ist und ein Refresher registriert ist, lädt es die parent App-Row (plain `select`, kein Lock — Secret ändert sich beim Token-Refresh nicht), entschlüsselt deren Client-Creds und übergibt sie als zweites Argument an den Refresher. Fehlt die parent-Row (z.B. App inzwischen gelöscht, sollte durch CASCADE nicht passieren), wird wie bei fehlendem Refresher das alte Token zurückgegeben bzw. `reauth_required` gesetzt (siehe Follow-up unten).

`listExpiringCredentials` bleibt unverändert (`provider = 'google'`); Background-Refresh läuft durch `getCredential` und erbt die parent-Auflösung.

## Provider-Module

`google.ts` / `shopify.ts` bleiben weitgehend unverändert (nehmen `clientId`/`clientSecret` bereits als Argumente). Die Worker-/API-Refresher-Registrierung wird angepasst: statt Env-Werten reichen sie die vom Store gelieferten `appCreds` durch.

## API-Routen (`src/api/index.ts`)

App-Verwaltung (Admin, `x-admin-key`):

- `POST /admin/credentials/oauth-app` — Body `{ name, provider: 'google'|'shopify', clientId, clientSecret }`. Validierung: name gegen `CREDENTIAL_NAME_PATTERN`, provider in Whitelist, clientId/Secret non-empty. 422 bei Verstoß.
- `GET /admin/credentials/oauth-app` — Liste ohne Secrets.
- `DELETE /admin/credentials/oauth-app/:name` — cascade.

Connect (geändert):

- `POST /admin/credentials/google/connect` — Body `{ name, app, scopes[] }`. Lädt App per `getOAuthApp(app)`, baut authUrl mit `app.clientId`. Verlangt `CREDENTIAL_MASTER_KEY` + `redirectUri`. 422, wenn App fehlt oder Provider nicht `google-app`.
- `POST /admin/credentials/shopify/connect` — Body `{ name, app, shop, scopes[] }`. Analog, plus `shop`-Pattern-Check.
- Der **OAuth-State** (single-use, Redis) trägt künftig `{ tokenName, appName, provider, scopes, shop? }` statt nur des Namens.

Callback (geändert):

- `GET /credentials/callback/google` — State konsumieren → `appName` → `getOAuthApp` → `exchangeCode({ clientId, clientSecret })` → `upsertCredential` mit `parentCredentialId = app.id`.
- `GET /credentials/callback/shopify` — **Reihenfolge geändert**: erst State konsumieren → App-Secret laden → **dann** HMAC mit diesem Secret verifizieren (heute nutzt der Callback `config.SHOPIFY_CLIENT_SECRET` vor dem State). Danach `exchangeCode` + upsert mit parent.

## Config & Compose

- `src/config.*`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` aus dem Schema entfernen. `CREDENTIAL_MASTER_KEY`, `PUBLIC_BASE_URL` bleiben.
- `docker-compose.yml`: `CREDENTIAL_MASTER_KEY` an **api und worker** durchreichen (bisher in keinem der beiden Services gesetzt — Lücke). Provider-Env entfällt.

## Deploy

- Migration ist additiv (`ALTER TABLE … ADD COLUMN`, Check-Constraint-Tausch) und läuft automatisch beim API-Boot (`runMigrations`, `src/api/index.ts:35`). Kein Datenverlust, leere `credential`-Tabelle in Prod.
- Vor Deploy: `CREDENTIAL_MASTER_KEY` (`openssl rand -base64 32`) in den Coolify-Env-Vars des `mq-app`-Projekts setzen.
- Erst nach Deploy: App-Credentials per `POST /admin/credentials/oauth-app` anlegen, dann Connect-Flow.

## Tests

- Store-Unit: `upsertOAuthApp`/`getOAuthApp` Roundtrip, `listOAuthApps` ohne Secrets, `deleteOAuthApp` cascade entfernt Tokens.
- `getCredential`-Refresh lädt parent App-Creds und übergibt sie an den Refresher; Refresh-Fail → `reauth_required`.
- Provider-Mismatch: `google/connect` mit `shopify-app` → Fehler.
- Routen: oauth-app CRUD (422-Pfade), Connect liefert authUrl, Callback löst App via State und setzt parent.
- Shopify-Callback: HMAC-Verifikation mit App-Secret nach State-Konsum.

## Offene Follow-ups (aus altem Final-Review, hier mitnehmen)

- `store.ts`: abgelaufenes Google-Token ohne auflösbare App-Creds soll Fehler werfen statt still altes Token zurückzugeben.
- PG-Integrationstest für `select … for update`-Lock fehlt weiterhin.
