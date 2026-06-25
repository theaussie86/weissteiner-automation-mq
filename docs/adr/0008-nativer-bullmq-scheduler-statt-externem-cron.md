# Nativer BullMQ-Scheduler statt externem Cron

Zeit- und intervallgesteuerte Jobs werden über den **nativen BullMQ-Scheduler** (`upsertJobScheduler` mit Cron-Pattern, wie heute schon für Cleanup und Credential-Refresh) ausgelöst, nicht über externe Scheduler wie Supabase pg_cron oder Trigger.dev. Eine neue Postgres-Tabelle `schedule` ist die **Source of Truth** (`name`, `cron`, `tz`, `job_type`, `payload`, `consumer`, `active`); beim API-Boot werden aktive Schedules idempotent in BullMQ ge-upsertet (gleiches Muster wie der stündliche Cleanup), sodass sie nach Redeploy oder Redis-Verlust reproduzierbar bleiben. Verwaltung via Admin-API (`POST/GET/DELETE /admin/schedules`).

Begründung: Die Plattform existiert, um n8n **und** Trigger.dev abzulösen — deren Kernwert ist gerade Scheduling plus durable Tasks. Bliebe das Scheduling extern (pg_cron POSTet an `/jobs`), wäre nur Compute verschoben und die Orchestrierung weiter über Consumer-Datenbanken zersplittert. Schedules gehören zum Executor. BullMQ leistet die Schwerarbeit; wir bauen nur dünnes CRUD plus Persistenz darüber.

## Consequences

- Schedules sind ein neues Domänen-Konzept (**Schedule** in CONTEXT.md), abgegrenzt vom einmaligen **Job** und vom internen Repeatable (Cleanup/Refresh, weiter hardcoded).
- Migrierte Consumer (z.B. Pinfinity) verlieren ihre pg_cron-Abhängigkeit; der Poll (z.B. Auto-Publish alle 10 min) läuft als plattform-eigener Schedule.
