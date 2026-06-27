# weissteiner-automation-mq

BullMQ-basierte Job-Plattform: führt FFmpeg-Verarbeitung und Drittdienst-Integrationen als asynchrone Jobs aus und löst schrittweise die bestehenden n8n-Instanzen ab.

Live: `https://mq.weissteiner-automation.com` · Domänensprache: [CONTEXT.md](CONTEXT.md) · Architektur-Entscheidungen: [docs/adr/](docs/adr/)

## Architektur

```
Consumer (n8n, Zapier, Dienste)
        │  API-Key (Bearer, Queue-Scopes)
        ▼
┌──────────────────┐     ┌──────────┐     ┌──────────────────┐
│  api              │────▶│  Redis    │◀───│  worker           │
│  Fastify          │     │  BullMQ   │    │  WORKER_QUEUES=…  │
│  /jobs /files     │     └──────────┘    │  media: conc 1    │
│  /admin           │                      │  integr.: conc 5  │
└────────┬─────────┘   shared volume      └────────┬─────────┘
         │◀───────────  mq-files  ────────────────▶│
         ▼                                          ▼
┌────────────────────────────────────────────────────────────┐
│  Postgres: consumer (API-Keys) · job_archive · Migrationen   │
└────────────────────────────────────────────────────────────┘
┌──────────────────┐
│  board            │  Bull Board, kein Traefik — nur 127.0.0.1:5100
│  (ssh -N mq-board)│  auf dem VPS, Zugriff via SSH-Tunnel
└──────────────────┘
```

Ein Docker-Image, drei Entrypoints (`api`, `worker`, `board`) — siehe ADR-0006. Queues nach Job-Art (`media`, `integrations`), Mandant ist Job-Attribut (ADR-0003, ADR-0007).

## API

Alle Job-Routen brauchen `Authorization: Bearer <api-key>`. Consumer + Scopes verwaltet `POST /admin/consumers` (Header `x-admin-key`).

```bash
# Job einreichen (tenant + callbackUrl optional)
curl -X POST https://mq.weissteiner-automation.com/jobs \
  -H "authorization: Bearer mq_..." -H "content-type: application/json" \
  -d '{"type":"media.extract-audio","payload":{"sourceUrl":"https://..."},
       "tenant":"wachmacherei","callbackUrl":"https://empfaenger.example/hook"}'

# Status abfragen
curl https://mq.weissteiner-automation.com/jobs/media/<jobId> -H "authorization: Bearer mq_..."

# Job-Archiv filtern (Admin)
curl "https://mq.weissteiner-automation.com/admin/jobs?tenant=wachmacherei&status=failed" \
  -H "x-admin-key: ..."
```

| Route | Auth | Zweck |
|---|---|---|
| `GET /health` | keine | Redis/Postgres-Check |
| `POST /jobs` | API-Key | Job einreichen (`type`, `payload`, `tenant?`, `callbackUrl?`) |
| `GET /jobs/:queue/:id` | API-Key + Scope | Status + Ergebnis |
| `GET /files/:key?exp&sig` | HMAC-Signatur | Temp-URL-Auslieferung (24h TTL) |
| `POST /admin/consumers` | Admin-Key | Consumer anlegen, Key einmalig im Klartext |
| `GET /admin/jobs` | Admin-Key | Archiv-Abfrage (tenant/consumer/type/status) |
| `POST /admin/schedules` | Admin-Key | Schedule anlegen (`name`, `cron`, `tz?`, `jobType`, `payload?`, `consumer`) |
| `GET /admin/schedules` | Admin-Key | Schedules auflisten |
| `DELETE /admin/schedules/:name` | Admin-Key | Schedule + BullMQ-Scheduler entfernen |

**Job-Typen**: `integrations.ping` (Smoke-Test), `media.extract-audio` (MP3, Legacy-Defaults 128k/22.05kHz), `media.thumbnail` (JPEG/PNG-Frame), `pinfinity.cleanup-published-images` (löscht Bilder längst veröffentlichter Pins aus Pinfinitys Supabase Storage; Payload `{ supabaseCredential, dryRun? }`). Registry: `src/jobs/`.

**Callbacks**: Worker POSTet nach completed/failed `{jobId, queue, type, status, tenant, result|error}` an die `callbackUrl` — HMAC-signiert im Header `X-MQ-Signature` (SHA-256 über den Raw-Body, Secret = `URL_SIGNING_SECRET`), 3 Versuche, nie Datei-Inhalte.

## Lokale Entwicklung

```bash
npm run dev:infra     # Redis (5379) + Postgres (5432) in Docker
npm run dev:api       # API auf :5001, Watch-Mode
npm run dev:worker    # Worker, Watch-Mode
npm run dev:board     # Bull Board auf :5002
npm test              # Vitest
```

`.env` (gitignored) trägt die lokalen URLs — Vorlage in `.env.example`. Ports im 5000er-Bereich (5000 selbst belegt macOS AirPlay). VS-Code-Debugging: Launch-Configs „Debug API/Worker" in `.vscode/launch.json`. Eingehende Webhooks lokal testen: ngrok-Tunnel auf 5001.

## Deploy & Betrieb

### Credential Store (ADR-0002)

Verschlüsselte Drittdienst-Zugänge in Postgres, referenziert per Name-Slug im Job-Payload.

| Env | Zweck |
|---|---|
| `CREDENTIAL_MASTER_KEY` | 32 Byte base64 (`openssl rand -base64 32`); ohne Wert ist der Store deaktiviert |

Endpoints (Admin: `x-admin-key`):

- `POST /admin/credentials` - apikey-Credential anlegen (`{name, provider: "apikey", data}`)
- `GET /admin/credentials` - Liste ohne Secrets
- `DELETE /admin/credentials/:name`
- `POST /admin/credentials/oauth-app` - OAuth-App anlegen (`{name, provider: "google"|"shopify", clientId, clientSecret}`); Client-Secret wird verschlüsselt im Store abgelegt
- `GET /admin/credentials/oauth-app` - App-Liste ohne Secrets
- `DELETE /admin/credentials/oauth-app/:name` - App löschen (kaskadiert: verknüpfte Tokens werden mitgelöscht)
- `POST /admin/credentials/google/connect` (`{name, app, scopes[]}`) - liefert `authUrl`, Consent im Browser durchklicken; `app` referenziert eine zuvor angelegte OAuth-App
- `POST /admin/credentials/shopify/connect` (`{name, app, shop, scopes[]}`) - liefert `authUrl`, Consent im Browser durchklicken; `app` referenziert eine zuvor angelegte OAuth-App
- `GET /credentials/callback/<provider>` - öffentlich, durch single-use State geschützt; Redirect-URI je Provider ist `<PUBLIC_BASE_URL>/credentials/callback/<provider>` (zu hinterlegen in der Google-/Shopify-App)

OAuth-Tokens werden lazy beim Lesen refresht (Row-Lock) plus alle 30 min proaktiv
(`credentials.refresh`, Horizont 45 min). Schlägt ein Refresh fehl, steht das Credential
auf `reauth_required` - Connect-Flow erneut durchlaufen.

- Push auf `main` → GitHub Actions (Typecheck, Tests, Docker-Build) → Coolify-Webhook deployt automatisch. Branch Protection verlangt grüne Checks.
- Coolify-Projekt „Weissteiner Automation BullMQ": `mq-postgres`, `mq-redis` (managed, ADR-0005), `mq-app` (Compose: api/worker/board).
- App-Secrets (`ADMIN_KEY`, `URL_SIGNING_SECRET`, `PUBLIC_BASE_URL`, DB-URLs) liegen in den Coolify-Env-Vars; lokal gespiegelt in der macOS-Keychain (`security find-generic-password -s mq-prod-admin-key -w`, analog `mq-prod-api-key-cwe-internal`, `mq-url-signing-secret`, `mq-coolify-api-token`).
- Env-Vars per API statt UI pflegen: `PATCH https://coolify.cweissteiner.de/api/v1/applications/<uuid>/envs` mit dem Coolify-Token.
- Bull Board Production: `ssh -N mq-board`, dann `http://localhost:5100`.
- Ergebnis-Dateien: Shared Volume `mq-files`, stündlicher Cleanup-Job löscht nach 24h (ADR-0004).

## Legacy

[ffmpeg-docker-api](https://github.com/theaussie86/ffmpeg-Docker-API) läuft unverändert auf `util.weissteiner-automation.com` bis zum Cutover (ADR-0001).

## Offen

Nativer Scheduler steht (ADR-0008, `/admin/schedules`). Pinfinity-Migration läuft: `pinfinity.cleanup-published-images` steht (erster Tracer). Betrieb: `pinfinity-supabase`-Credential (`POST /admin/credentials`, `{name, provider:"apikey", data:{url, serviceRoleKey}}`) und Schedule (`POST /admin/schedules`, `payload:{supabaseCredential, dryRun}`) anlegen, ersten Lauf mit `dryRun:true`, dann pg_cron in Pinfinitys Supabase abdrehen. Nächste Job-Typen: `ai.generate-pin-metadata`, `pinterest.publish-pin`. Weitere Blöcke: Schedule-Läufe ins Job-Archiv schreiben (aktuell archiviert nur `POST /jobs`) · Flows/FlowProducer erst beim ersten echten Fan-in-Fall · Staging-Environment bei Bedarf.
