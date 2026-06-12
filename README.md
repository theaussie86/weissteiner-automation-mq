# weissteiner-automation-mq

BullMQ-basierte Job-Plattform: führt FFmpeg-Verarbeitung und Drittdienst-Integrationen als asynchrone Jobs aus und löst schrittweise die bestehenden n8n-Instanzen ab.

Domänensprache: [CONTEXT.md](CONTEXT.md) · Architektur-Entscheidungen: [docs/adr/](docs/adr/)

## Architektur (beschlossen, noch nicht gebaut)

```
Consumer (n8n, Zapier, Dienste)
        │  API-Key (Scope: Queues)
        ▼
┌─────────────────┐     ┌──────────┐
│  API-Container   │────▶│  Redis    │◀────┌──────────────────┐
│  Express          │     │  BullMQ   │     │  Worker-Container │
│  + Bull Board     │     └──────────┘     │  WORKER_QUEUES=…  │
└────────┬─────────┘                        │  media: sandboxed │
         │      shared volume (Temp-Dateien)│  integr.: in-proc │
         │◀────────────────────────────────▶└────────┬─────────┘
         ▼                                            ▼
┌──────────────────────────────────────────────────────────┐
│  Postgres: Credential Store · Job-Archiv · Flows · Analytics │
└──────────────────────────────────────────────────────────┘
```

- **Stack**: Express + TypeScript, BullMQ, Redis, Postgres, Vitest, Docker/Coolify
- **Queues**: `media` (FFmpeg, sandboxed), `integrations` (Google/Shopify/Supabase, in-process), später `flows`
- **Ergebnis**: Polling (`GET /jobs/:id`) immer, Webhook-Callback optional; Dateien als signierte Temp-URL
- **Auth**: API-Key pro Consumer (gehasht, Queue-Scopes, Rate-Limit)
- **Credentials**: AES-256-GCM in Postgres, zentraler OAuth-Refresh (siehe ADR-0002)
- **Deploy**: Coolify auf Hostinger-VPS; Postgres/Redis als Coolify-Services, App stateless aus `main` (siehe ADR-0005)
- **Legacy**: [ffmpeg-docker-api](https://github.com/theaussie86/ffmpeg-Docker-API) läuft unverändert bis zum Cutover (siehe ADR-0001)
