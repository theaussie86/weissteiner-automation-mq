# Weissteiner Automation MQ

Zentrale Job-Plattform auf BullMQ-Basis, die rechenintensive Aufgaben (FFmpeg) und Drittdienst-Integrationen (Google, Shopify, Supabase) ausführt und mittelfristig die bestehenden n8n-Instanzen ablöst. Die Plattform läuft unter `mq.weissteiner-automation.com` (Legacy-Dienst: `util.weissteiner-automation.com`).

## Language

### Jobs & Ausführung

**Job**:
Eine einzelne, asynchron ausgeführte Arbeitseinheit mit typisiertem Payload, eingereicht von einem Consumer.
_Avoid_: Task, Request, Auftrag

**Job-Typ**:
Die Definition einer Job-Art: Name (z.B. `media.extract-audio`), Payload-Schema (Zod), Processor, Queue-Zuordnung, benötigte Credential-Typen.
_Avoid_: Job-Klasse, Endpoint

**Job-Registry**:
Das Verzeichnis aller Job-Typen; einzige Quelle für API-Validierung, Worker-Dispatch und Doku.

**Queue**:
Ein nach Job-Art geschnittener BullMQ-Kanal (`media`, `integrations`, später `flows`). Mandant/Quelle ist Job-Attribut, nie eigene Queue.

**Worker**:
Ein Container, der Jobs aus per Env-Var zugewiesenen Queues konsumiert. Queue-agnostischer Code; Spezialisierung ist Betriebsentscheidung.

**Flow**:
Ein mehrstufiger Ablauf aus verketteten Jobs (BullMQ Parent-Child). Ablöse-Ziel für n8n-Workflows.
_Avoid_: Workflow (reserviert für n8n-Altbestand)

### Zugriff & Ergebnis

**Consumer**:
Ein externer Dienst (n8n-Instanz, Zapier, eigener Service) mit eigenem API-Key und Queue-Scopes.
_Avoid_: Client, User, Mandant

**Mandant**:
Der Kunde, dessen Daten ein Job betrifft (z.B. `wachmacherei`) — optionales Job-Attribut (`tenant`), nie eigene Queue. Filterbar im Job-Archiv.
_Avoid_: Customer, Kunde (als Fachbegriff), eigene Queue pro Mandant

**Callback**:
Optionaler Webhook pro Job; Worker POSTet das Ergebnis an die `callbackUrl` des Consumers.

**Job-Archiv**:
Persistierte Job-Historie in Postgres (Status, Ergebnis, Consumer, Timing) für Audit und Analytics — unabhängig vom flüchtigen Redis-State.

**Temp-URL**:
Signierte, ablaufende URL, über die der API-Container Ergebnis-Dateien ausliefert.
_Avoid_: Download-Link, Base64-Response

### Credentials

**Credential**:
Ein verschlüsselt gespeicherter Zugang zu einem Drittdienst (Google-Konto, Shopify-Shop, Supabase-Instanz, API-Key), inkl. OAuth-Refresh-Token wo nötig.
_Avoid_: Secret (reserviert für App-Secrets)

**Credential Store**:
Postgres-Tabelle mit AES-256-GCM-verschlüsselten Credentials; ein Master-Key (App-Secret) entschlüsselt. Übernimmt zentral den OAuth-Token-Refresh.

**App-Secret**:
Statische Deployment-Konfiguration (Redis-Passwort, Master-Key, Admin-Key) — via Env/Coolify, nie im Credential Store.

### Migration

**Legacy-Dienst**:
Der bestehende ffmpeg-docker-api Express-Server; läuft unverändert bis zum Cutover.

**Cutover**:
Der Zeitpunkt, ab dem ein Consumer (oder der letzte) vom Legacy-Dienst bzw. einer n8n-Instanz auf die Plattform umgestellt ist.

## Relationships

- Ein **Consumer** reicht **Jobs** ein; sein API-Key-Scope bestimmt die erlaubten **Queues**
- Ein **Job** gehört zu genau einem **Job-Typ**; die **Job-Registry** kennt alle **Job-Typen**
- Ein **Job-Typ** gehört zu genau einer **Queue**; ein **Worker** konsumiert eine oder mehrere **Queues**
- Ein **Job** referenziert null bis n **Credentials** aus dem **Credential Store**
- Ein **Flow** besteht aus mehreren verketteten **Jobs**
- Jeder **Job** landet im **Job-Archiv**; Datei-Ergebnisse werden als **Temp-URL** ausgeliefert, optional zusätzlich per **Callback** gemeldet

## Example dialogue

> **Dev:** "Wenn eine n8n-Instanz einen `media.extract-audio`-**Job** einreicht — woher weiß der **Worker**, welches Google-Konto er nutzen soll?"
> **Domain expert:** "Gar nicht über den Payload-Inhalt selbst — der **Job** referenziert ein **Credential** per ID. Der **Worker** holt es aus dem **Credential Store**, der refresht bei Bedarf auch das OAuth-Token. Der **Consumer** schickt nie Klartext-Zugänge mit."
> **Dev:** "Und das fertige MP3 geht im **Callback** mit?"
> **Domain expert:** "Nein, im **Callback** steht nur Status plus **Temp-URL**. Dateien laufen nie durch den Webhook-Body."

## Flagged ambiguities

- "Secrets Management" wurde für zwei Konzepte verwendet — aufgelöst: **App-Secret** (statisch, Env/Coolify) vs. **Credential** (dynamisch, Credential Store).
- "Workflow" meinte sowohl n8n-Bestand als auch künftige Plattform-Abläufe — aufgelöst: n8n-Altbestand heißt Workflow, Plattform-Äquivalent heißt **Flow**.
- n8n war zugleich als Client und als Ablöse-Ziel beschrieben — aufgelöst: n8n-Instanzen sind übergangsweise **Consumer**, werden aber pro Workflow durch **Flows** abgelöst (Migrationspfad).
