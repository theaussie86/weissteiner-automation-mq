# Native Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plattform-eigene, cron-gesteuerte Schedules, die automatisch Jobs einreichen — als isoliertes Primitiv, bewiesen mit einem `integrations.ping`-Cron, ohne Pinfinity-Credentials.

**Architecture:** Neue Postgres-Tabelle `schedule` ist Source of Truth (ADR-0008). Ein dünnes Store-Modul macht CRUD, ein Sync-Modul upsertet aktive Schedules über `Queue.upsertJobScheduler` in BullMQ (gleiches Muster wie der stündliche Cleanup im Worker). Admin-Routen (`/admin/schedules`) verwalten die Tabelle und upserten/entfernen den BullMQ-Scheduler sofort mit; beim API-Boot werden alle aktiven Schedules idempotent ge-upsertet. Der gescheduelte Job läuft durch denselben Worker-Pfad wie ein `POST /jobs`-Job (gleiche `job.data`-Form).

**Tech Stack:** TypeScript (ESM, Node >=24), Fastify 5, BullMQ 5, pg 8, node-pg-migrate 8, Zod 4, Vitest 4.

## Global Constraints

- **Sprache/Doku:** Kommentare und Doku auf Deutsch, echte Umlaute (ä/ö/ü/ß), keine ae/oe/ue/ss-Ersetzung. Nur einzelne Bindestriche, keine Gedankenstriche.
- **ESM-Imports:** Lokale Imports immer mit `.js`-Endung (z.B. `from "./store.js"`), auch für `.ts`-Quellen — Projekt ist `"type": "module"`.
- **Test-Stil:** Unit-Tests mit In-Memory-Fake-Pool/Fake-Queue (kein echtes Postgres/Redis im Test), exakt wie `src/credentials/store.test.ts`. Echtes End-to-End nur als manuelle Verifikation (Task 5).
- **Admin-Guard:** Alle `/admin/*`-Routen laufen hinter `requireAdmin` (Header `x-admin-key`), das ist schon im `onRequest`-Hook ausgenommen von der API-Key-Prüfung.
- **Name-Pattern:** Schedule-Name `^[a-z0-9][a-z0-9-]{0,63}$` (wie `CREDENTIAL_NAME_PATTERN`).
- **Migration-Timestamp:** Neue Migration muss numerisch nach `1750800000000_oauth_app.cjs` liegen — nutze `1750900000000_schedule.cjs`.
- **Scope-Grenze (YAGNI):** Kein Update/Deactivate-Endpoint, kein FlowProducer, keine Pinterest-/Supabase-Credentials, kein Archivieren von Schedule-Läufen (Follow-up, siehe Task 5). Nur create/list/delete + Boot-Sync.

---

### Task 1: Migration + Schedule-Store (CRUD)

Tabelle `schedule` als Source of Truth plus ein Store-Modul mit create/list/delete und `listActive`. Store wird gegen einen Fake-Pool unit-getestet (kein echtes Postgres).

**Files:**
- Create: `migrations/1750900000000_schedule.cjs`
- Create: `src/schedules/store.ts`
- Test: `src/schedules/store.test.ts`

**Interfaces:**
- Consumes: nichts (erste Task).
- Produces:
  - `SCHEDULE_NAME_PATTERN: RegExp`
  - `interface ScheduleInput { name: string; cron: string; tz: string; jobType: string; payload: unknown; consumer: string }`
  - `interface ScheduleRecord extends ScheduleInput { id: string; active: boolean; createdAt: string }`
  - `createSchedule(db: pg.Pool, input: ScheduleInput): Promise<ScheduleRecord | null>` — `null` bei Name-Kollision (Postgres-Fehlercode `23505`).
  - `listSchedules(db: pg.Pool): Promise<ScheduleRecord[]>`
  - `listActiveSchedules(db: pg.Pool): Promise<ScheduleRecord[]>`
  - `getSchedule(db: pg.Pool, name: string): Promise<ScheduleRecord | null>` — `null` wenn nicht vorhanden.
  - `deleteSchedule(db: pg.Pool, name: string): Promise<boolean>` — `false` wenn nichts gelöscht.

- [ ] **Step 1: Migration schreiben**

Create `migrations/1750900000000_schedule.cjs`:

```js
/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable("schedule", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true, unique: true },
    cron: { type: "text", notNull: true },
    tz: { type: "text", notNull: true, default: "UTC" },
    job_type: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true, default: "{}" },
    consumer: { type: "text", notNull: true },
    active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  // Boot-Sync und der Background-Scan lesen nur aktive Schedules.
  pgm.createIndex("schedule", "active", { where: "active" });
};

exports.down = (pgm) => {
  pgm.dropTable("schedule");
};
```

- [ ] **Step 2: Failing Test für den Store schreiben**

Create `src/schedules/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listActiveSchedules,
  listSchedules,
  SCHEDULE_NAME_PATTERN,
  type ScheduleInput,
} from "./store.js";
import type pg from "pg";

interface Row {
  id: string;
  name: string;
  cron: string;
  tz: string;
  job_type: string;
  payload: unknown;
  consumer: string;
  active: boolean;
  created_at: string;
}

// Fake-Pool: bedient insert ... returning, select, delete gegen eine In-Memory-Liste.
// Wirft bei doppeltem Namen einen Fehler mit code 23505, wie Postgres' unique-Constraint.
function fakePool(initial: Row[] = []) {
  const rows = [...initial];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/^insert/i.test(sql)) {
      const [name, cron, tz, jobType, payload, consumer] = params as [string, string, string, string, unknown, string];
      if (rows.some((r) => r.name === name)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      const row: Row = {
        id: `id-${rows.length + 1}`,
        name,
        cron,
        tz,
        job_type: jobType,
        payload,
        consumer,
        active: true,
        created_at: "2026-06-25T00:00:00.000Z",
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/^delete/i.test(sql)) {
      const name = params[0] as string;
      const idx = rows.findIndex((r) => r.name === name);
      if (idx === -1) return { rows: [], rowCount: 0 };
      rows.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }
    if (/^select/i.test(sql) && /where name = \$1/i.test(sql)) {
      const found = rows.filter((r) => r.name === (params[0] as string));
      return { rows: found, rowCount: found.length };
    }
    // select
    const active = /where active/i.test(sql);
    const out = active ? rows.filter((r) => r.active) : rows;
    return { rows: out, rowCount: out.length };
  };
  return { query } as unknown as pg.Pool;
}

const input: ScheduleInput = {
  name: "pinfinity-ping",
  cron: "*/10 * * * *",
  tz: "Europe/Vienna",
  jobType: "integrations.ping",
  payload: { message: "tick" },
  consumer: "pinfinity",
};

describe("schedule store", () => {
  it("erlaubt nur kleinbuchstaben, ziffern, bindestriche im namen", () => {
    expect(SCHEDULE_NAME_PATTERN.test("pinfinity-ping")).toBe(true);
    expect(SCHEDULE_NAME_PATTERN.test("Pinfinity Ping")).toBe(false);
  });

  it("legt einen schedule an und gibt den record zurück", async () => {
    const db = fakePool();
    const record = await createSchedule(db, input);
    expect(record).not.toBeNull();
    expect(record!.id).toBe("id-1");
    expect(record!.name).toBe("pinfinity-ping");
    expect(record!.jobType).toBe("integrations.ping");
    expect(record!.active).toBe(true);
  });

  it("gibt null bei doppeltem namen zurück", async () => {
    const db = fakePool();
    await createSchedule(db, input);
    const dupe = await createSchedule(db, input);
    expect(dupe).toBeNull();
  });

  it("listet aktive schedules", async () => {
    const db = fakePool();
    await createSchedule(db, input);
    const active = await listActiveSchedules(db);
    expect(active).toHaveLength(1);
    expect(active[0]!.jobType).toBe("integrations.ping");
  });

  it("liest einen schedule nach namen, null wenn fehlend", async () => {
    const db = fakePool();
    await createSchedule(db, input);
    const found = await getSchedule(db, "pinfinity-ping");
    expect(found?.jobType).toBe("integrations.ping");
    expect(await getSchedule(db, "fehlt")).toBeNull();
  });

  it("löscht nach namen und meldet treffer", async () => {
    const db = fakePool();
    await createSchedule(db, input);
    expect(await deleteSchedule(db, "pinfinity-ping")).toBe(true);
    expect(await deleteSchedule(db, "fehlt")).toBe(false);
    expect(await listSchedules(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/schedules/store.test.ts`
Expected: FAIL — Modul `./store.js` existiert nicht / Funktionen undefined.

- [ ] **Step 4: Store implementieren**

Create `src/schedules/store.ts`:

```ts
import type pg from "pg";

// Schedule-Store (ADR-0008): die schedule-Tabelle ist Source of Truth für alle
// cron-gesteuerten Jobs. Der BullMQ-Scheduler wird daraus abgeleitet (siehe sync.ts).
export const SCHEDULE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ScheduleInput {
  name: string;
  cron: string;
  tz: string;
  jobType: string;
  payload: unknown;
  consumer: string;
}

export interface ScheduleRecord extends ScheduleInput {
  id: string;
  active: boolean;
  createdAt: string;
}

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  tz: string;
  job_type: string;
  payload: unknown;
  consumer: string;
  active: boolean;
  created_at: string | Date;
}

function mapRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    tz: row.tz,
    jobType: row.job_type,
    payload: row.payload,
    consumer: row.consumer,
    active: row.active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_COLS = "id, name, cron, tz, job_type, payload, consumer, active, created_at";

export async function createSchedule(db: pg.Pool, input: ScheduleInput): Promise<ScheduleRecord | null> {
  try {
    const result = await db.query<ScheduleRow>(
      `insert into schedule (name, cron, tz, job_type, payload, consumer)
       values ($1, $2, $3, $4, $5, $6)
       returning ${SELECT_COLS}`,
      [input.name, input.cron, input.tz, input.jobType, JSON.stringify(input.payload ?? {}), input.consumer],
    );
    return mapRow(result.rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return null;
    throw err;
  }
}

export async function listSchedules(db: pg.Pool): Promise<ScheduleRecord[]> {
  const result = await db.query<ScheduleRow>(`select ${SELECT_COLS} from schedule order by created_at desc`);
  return result.rows.map(mapRow);
}

export async function listActiveSchedules(db: pg.Pool): Promise<ScheduleRecord[]> {
  const result = await db.query<ScheduleRow>(`select ${SELECT_COLS} from schedule where active order by created_at desc`);
  return result.rows.map(mapRow);
}

export async function getSchedule(db: pg.Pool, name: string): Promise<ScheduleRecord | null> {
  const result = await db.query<ScheduleRow>(`select ${SELECT_COLS} from schedule where name = $1`, [name]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function deleteSchedule(db: pg.Pool, name: string): Promise<boolean> {
  const result = await db.query("delete from schedule where name = $1", [name]);
  return result.rowCount === 1;
}
```

- [ ] **Step 5: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/schedules/store.test.ts`
Expected: PASS (6 Tests grün).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add migrations/1750900000000_schedule.cjs src/schedules/store.ts src/schedules/store.test.ts
git commit -m "feat: schedule-Tabelle und Store-CRUD"
```

---

### Task 2: Validierungs-Helfer

Reine, ohne IO testbare Validierung für Cron-Form und Timezone — damit die Route klein bleibt und die Logik unter Test steht.

**Files:**
- Create: `src/schedules/validate.ts`
- Test: `src/schedules/validate.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces:
  - `isCronShape(cron: string): boolean` — true bei 5 oder 6 leerzeichengetrennten Feldern (Grobprüfung; BullMQ validiert das Pattern beim Upsert endgültig).
  - `isValidTimezone(tz: string): boolean` — true wenn `Intl` die Zone kennt.

- [ ] **Step 1: Failing Test schreiben**

Create `src/schedules/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isCronShape, isValidTimezone } from "./validate.js";

describe("schedule validation", () => {
  it("akzeptiert 5- und 6-feld-cron", () => {
    expect(isCronShape("*/10 * * * *")).toBe(true);
    expect(isCronShape("0 9 * * 1-5")).toBe(true);
    expect(isCronShape("30 0 9 * * *")).toBe(true);
  });

  it("lehnt leere oder zu kurze cron-ausdrücke ab", () => {
    expect(isCronShape("")).toBe(false);
    expect(isCronShape("* * *")).toBe(false);
    expect(isCronShape("   ")).toBe(false);
  });

  it("erkennt gültige timezones", () => {
    expect(isValidTimezone("Europe/Vienna")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("lehnt unbekannte timezones ab", () => {
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/schedules/validate.test.ts`
Expected: FAIL — `./validate.js` existiert nicht.

- [ ] **Step 3: Validierung implementieren**

Create `src/schedules/validate.ts`:

```ts
// Grobprüfung der Cron-Form: 5 (Standard) oder 6 (mit Sekunden) Felder.
// Die endgültige Pattern-Validierung macht BullMQ beim upsertJobScheduler.
export function isCronShape(cron: string): boolean {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 || fields.length === 6;
}

// Timezone gegen die Intl-Datenbank prüfen: unbekannte Zone wirft RangeError.
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/schedules/validate.test.ts`
Expected: PASS (4 Tests grün).

- [ ] **Step 5: Commit**

```bash
git add src/schedules/validate.ts src/schedules/validate.test.ts
git commit -m "feat: schedule-Validierung für cron-form und timezone"
```

---

### Task 3: BullMQ-Scheduler-Sync

Dünnes Modul, das einen Schedule-Record in einen BullMQ-Job-Scheduler übersetzt (upsert) bzw. entfernt. Der gescheduelte Job trägt dieselbe `data`-Form wie ein `POST /jobs`-Job, damit der bestehende Worker-Pfad ihn unverändert verarbeitet.

**Files:**
- Create: `src/schedules/sync.ts`
- Test: `src/schedules/sync.test.ts`

**Interfaces:**
- Consumes: `ScheduleRecord` aus `./store.js` (Felder `name`, `cron`, `tz`, `jobType`, `payload`, `consumer`).
- Produces:
  - `type SchedulerQueue = Pick<import("bullmq").Queue, "upsertJobScheduler" | "removeJobScheduler">`
  - `upsertScheduler(queue: SchedulerQueue, s: ScheduleRecord): Promise<void>`
  - `removeScheduler(queue: SchedulerQueue, name: string): Promise<boolean>`

- [ ] **Step 1: Failing Test schreiben**

Create `src/schedules/sync.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { removeScheduler, upsertScheduler } from "./sync.js";
import type { ScheduleRecord } from "./store.js";

const record: ScheduleRecord = {
  id: "id-1",
  name: "pinfinity-ping",
  cron: "*/10 * * * *",
  tz: "Europe/Vienna",
  jobType: "integrations.ping",
  payload: { message: "tick" },
  consumer: "pinfinity",
  active: true,
  createdAt: "2026-06-25T00:00:00.000Z",
};

describe("scheduler sync", () => {
  it("upsertet mit cron-pattern, tz und job-data-form des POST /jobs-pfads", async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined), removeJobScheduler: vi.fn() };
    await upsertScheduler(queue, record);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "pinfinity-ping",
      { pattern: "*/10 * * * *", tz: "Europe/Vienna" },
      {
        name: "integrations.ping",
        data: { payload: { message: "tick" }, consumer: "pinfinity", tenant: null, callbackUrl: null },
      },
    );
  });

  it("entfernt nach scheduler-id (name)", async () => {
    const queue = { upsertJobScheduler: vi.fn(), removeJobScheduler: vi.fn().mockResolvedValue(true) };
    const ok = await removeScheduler(queue, "pinfinity-ping");
    expect(ok).toBe(true);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith("pinfinity-ping");
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `npx vitest run src/schedules/sync.test.ts`
Expected: FAIL — `./sync.js` existiert nicht.

- [ ] **Step 3: Sync implementieren**

Create `src/schedules/sync.ts`:

```ts
import type { Queue } from "bullmq";
import type { ScheduleRecord } from "./store.js";

// Nur die zwei Queue-Methoden, die der Sync braucht — erleichtert das Testen mit Fakes.
export type SchedulerQueue = Pick<Queue, "upsertJobScheduler" | "removeJobScheduler">;

// Übersetzt einen Schedule-Record in einen BullMQ-Job-Scheduler. Die job.data-Form
// (payload, consumer, tenant, callbackUrl) ist identisch zum POST /jobs-Pfad, damit der
// bestehende Worker den gescheduelten Job unverändert verarbeitet, archiviert und Callbacks sendet.
export async function upsertScheduler(queue: SchedulerQueue, s: ScheduleRecord): Promise<void> {
  await queue.upsertJobScheduler(
    s.name,
    { pattern: s.cron, tz: s.tz },
    { name: s.jobType, data: { payload: s.payload, consumer: s.consumer, tenant: null, callbackUrl: null } },
  );
}

export async function removeScheduler(queue: SchedulerQueue, name: string): Promise<boolean> {
  return queue.removeJobScheduler(name);
}
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `npx vitest run src/schedules/sync.test.ts`
Expected: PASS (2 Tests grün).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 6: Commit**

```bash
git add src/schedules/sync.ts src/schedules/sync.test.ts
git commit -m "feat: BullMQ-Scheduler-Sync aus Schedule-Records"
```

---

### Task 4: Admin-Routen + Boot-Sync verdrahten

`POST/GET/DELETE /admin/schedules` in der bestehenden Fastify-App plus Boot-Sync aller aktiven Schedules. POST validiert Name, Cron-Form, Timezone, Job-Typ (Registry) und Payload (gegen das Payload-Schema des Job-Typs), schreibt in die Tabelle und upsertet sofort den BullMQ-Scheduler in die Queue des Job-Typs. DELETE entfernt Zeile und Scheduler.

**Files:**
- Modify: `src/api/index.ts` (Importe oben; neue Routen nach dem `DELETE /admin/credentials/oauth-app/:name`-Block bei Zeile ~279; Boot-Sync nach dem `getQueue`-Helper)

**Interfaces:**
- Consumes:
  - aus `../schedules/store.js`: `SCHEDULE_NAME_PATTERN`, `createSchedule`, `getSchedule`, `listSchedules`, `listActiveSchedules`, `deleteSchedule`.
  - aus `./schedules/validate.js`: `isCronShape`, `isValidTimezone`.
  - aus `./schedules/sync.js`: `upsertScheduler`, `removeScheduler`.
  - bestehend in `index.ts`: `requireAdmin`, `getQueue`, `getJobType`, `db`.
- Produces: HTTP-Endpunkte (kein TS-Export).

- [ ] **Step 1: Importe ergänzen**

In `src/api/index.ts`, nach dem bestehenden Block der Credential-Importe (nach Zeile ~27, `import * as shopify ...`), einfügen:

```ts
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listActiveSchedules,
  listSchedules,
  SCHEDULE_NAME_PATTERN,
} from "../schedules/store.js";
import { isCronShape, isValidTimezone } from "../schedules/validate.js";
import { removeScheduler, upsertScheduler } from "../schedules/sync.js";
```

- [ ] **Step 2: Boot-Sync nach dem getQueue-Helper einfügen**

In `src/api/index.ts`, direkt nach der `getQueue`-Funktion (nach Zeile ~54), einfügen:

```ts
// Boot-Sync (ADR-0008): aktive Schedules idempotent in BullMQ upserten — gleiches
// Muster wie der stündliche Cleanup im Worker. Reproduziert Schedules nach Redeploy
// oder Redis-Verlust aus der Source of Truth in Postgres.
async function syncSchedulesOnBoot(): Promise<void> {
  const active = await listActiveSchedules(db);
  for (const schedule of active) {
    const jobType = getJobType(schedule.jobType);
    if (!jobType) {
      console.error(JSON.stringify({ event: "schedule.skip", reason: "unknown_job_type", schedule: schedule.name }));
      continue;
    }
    await upsertScheduler(getQueue(jobType.queue), schedule);
  }
  console.log(JSON.stringify({ event: "schedule.synced", count: active.length }));
}
await syncSchedulesOnBoot();
```

- [ ] **Step 3: Routen nach dem oauth-app-DELETE-Block einfügen**

In `src/api/index.ts`, nach dem `app.delete("/admin/credentials/oauth-app/:name", ...)`-Block (nach Zeile ~279), einfügen:

```ts
// Native Schedules (ADR-0008): Source of Truth ist die schedule-Tabelle; der BullMQ-Scheduler
// wird sofort mit upsertet/entfernt. Ein gescheduelter Job läuft durch denselben Worker-Pfad
// wie ein POST /jobs-Job.
app.post<{ Body: { name: string; cron: string; tz?: string; jobType: string; payload?: unknown; consumer: string } }>(
  "/admin/schedules",
  async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { name, cron, tz, jobType: jobTypeName, payload, consumer } = request.body ?? {};
    if (typeof name !== "string" || !SCHEDULE_NAME_PATTERN.test(name)) {
      return reply.code(422).send({ error: "Invalid name: lowercase letters, digits, hyphens, max 64 chars" });
    }
    if (typeof cron !== "string" || !isCronShape(cron)) {
      return reply.code(422).send({ error: "Invalid cron: expected 5 or 6 space-separated fields" });
    }
    const timezone = tz ?? "UTC";
    if (!isValidTimezone(timezone)) {
      return reply.code(422).send({ error: `Invalid tz: ${timezone}` });
    }
    if (typeof consumer !== "string" || !consumer) {
      return reply.code(422).send({ error: "consumer required" });
    }
    const jobType = typeof jobTypeName === "string" ? getJobType(jobTypeName) : undefined;
    if (!jobType) {
      return reply.code(422).send({ error: `Unknown job type: ${jobTypeName}` });
    }
    const parsed = jobType.payloadSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: "Invalid payload", issues: parsed.error.issues });
    }
    const record = await createSchedule(db, {
      name,
      cron,
      tz: timezone,
      jobType: jobType.name,
      payload: parsed.data,
      consumer,
    });
    if (!record) return reply.code(409).send({ error: `Schedule already exists: ${name}` });
    try {
      await upsertScheduler(getQueue(jobType.queue), record);
    } catch (err) {
      // Cron vom BullMQ-Scheduler abgelehnt: Zeile zurücknehmen, damit DB und Scheduler konsistent bleiben.
      await deleteSchedule(db, name);
      return reply.code(422).send({ error: `Scheduler rejected cron: ${(err as Error).message}` });
    }
    return reply.code(201).send({ id: record.id, name: record.name, queue: jobType.queue });
  },
);

app.get("/admin/schedules", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const schedules = await listSchedules(db);
  return { schedules, count: schedules.length };
});

app.delete<{ Params: { name: string } }>("/admin/schedules/:name", async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  // Erst die Zeile lesen, um aus dem Job-Typ die Queue des Schedulers zu bestimmen.
  const existing = await getSchedule(db, request.params.name);
  if (!existing) return reply.code(404).send({ error: "Schedule not found" });
  const jobType = getJobType(existing.jobType);
  await deleteSchedule(db, request.params.name);
  if (jobType) await removeScheduler(getQueue(jobType.queue), request.params.name).catch(() => false);
  return reply.code(204).send();
});
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: keine Fehler.

- [ ] **Step 5: Bestehende Test-Suite laufen lassen (keine Regression)**

Run: `npm test`
Expected: alle bisherigen Tests weiter grün (Scheduler-Module + bestehende).

- [ ] **Step 6: Commit**

```bash
git add src/api/index.ts
git commit -m "feat: /admin/schedules-Routen und Boot-Sync"
```

---

### Task 5: End-to-End-Verifikation + Doku

Beweis am laufenden System: ein `integrations.ping`-Schedule feuert und der Worker verarbeitet den Job. Plus README-Aktualisierung. (CONTEXT.md-Term `Schedule` und ADR-0008 existieren bereits.)

**Files:**
- Modify: `README.md` (API-Tabelle + Abschnitt "Offen")

- [ ] **Step 1: Infra + API + Worker lokal starten**

```bash
npm run dev:infra
npm run dev:api      # eigenes Terminal — migriert beim Boot, loggt {"event":"schedule.synced","count":0}
npm run dev:worker   # eigenes Terminal — konsumiert media + integrations
```

Expected: API-Log zeigt `schedule.synced` mit `count:0`; Worker-Log zeigt `worker.started`.

- [ ] **Step 2: Minuetlichen Ping-Schedule anlegen**

`<ADMIN_KEY>` aus `.env` einsetzen:

```bash
curl -X POST http://localhost:5001/admin/schedules \
  -H "x-admin-key: <ADMIN_KEY>" -H "content-type: application/json" \
  -d '{"name":"smoke-ping","cron":"* * * * *","tz":"UTC","jobType":"integrations.ping","payload":{"message":"tick"},"consumer":"smoke"}'
```

Expected: `201` mit `{"id":"...","name":"smoke-ping","queue":"integrations"}`.

- [ ] **Step 3: Liste prüfen**

```bash
curl http://localhost:5001/admin/schedules -H "x-admin-key: <ADMIN_KEY>"
```

Expected: `count: 1`, der Schedule mit `jobType: "integrations.ping"`.

- [ ] **Step 4: Auf den nächsten Minutenwechsel warten, Worker-Log beobachten**

Innerhalb von max. 60s zeigt das Worker-Log:

```
{"event":"completed","queue":"integrations","jobId":"...","type":"integrations.ping"}
```

Expected: Der gescheduelte Job lief automatisch durch — Scheduler-Primitiv bewiesen.

- [ ] **Step 5: Aufräumen + Entfernung verifizieren**

```bash
curl -X DELETE http://localhost:5001/admin/schedules/smoke-ping -H "x-admin-key: <ADMIN_KEY>"
curl http://localhost:5001/admin/schedules -H "x-admin-key: <ADMIN_KEY>"
```

Expected: DELETE `204`; Liste danach `count: 0`. Worker feuert keinen weiteren Ping mehr.

- [ ] **Step 6: README aktualisieren**

In `README.md` in der API-Routen-Tabelle (nach der `GET /admin/jobs`-Zeile) ergänzen:

```md
| `POST /admin/schedules` | Admin-Key | Schedule anlegen (`name`, `cron`, `tz?`, `jobType`, `payload?`, `consumer`) |
| `GET /admin/schedules` | Admin-Key | Schedules auflisten |
| `DELETE /admin/schedules/:name` | Admin-Key | Schedule + BullMQ-Scheduler entfernen |
```

Im Abschnitt "Offen" die Zeile ersetzen:

```md
Pinfinity-Migration: Job-Typen `pinterest.publish-pin` (liest Token via Supabase-Service-Role, ADR-0009), `ai.generate-pin-metadata`, `scrape.blog-article` auf den nativen Scheduler setzen · Schedule-Laeufe ins Job-Archiv schreiben (aktuell nur POST /jobs archiviert) · Flows/FlowProducer erst bei erstem echten Fan-in-Fall.
```

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: /admin/schedules in README, Offen-Roadmap aktualisiert"
```

---

## Self-Review

**Spec coverage** (gegen die Grilling-Entscheidungen + ADR-0008):
- `schedule`-Tabelle als Source of Truth → Task 1 ✓
- Admin-CRUD `/admin/schedules` → Task 4 (POST/GET/DELETE) ✓
- Boot-Upsert aktiver Schedules (idempotent, wie Cleanup) → Task 4 Step 2 ✓
- Sofort-Upsert bei POST, Entfernung bei DELETE → Task 4 ✓
- Bewiesen mit `integrations.ping`, keine Pinfinity-Creds → Task 5 ✓
- Glossar-Term `Schedule` + ADR-0008 → schon vor diesem Plan geschrieben ✓
- Out of scope (dokumentiert): Archivierung von Schedule-Läufen, Pinterest/Supabase-Jobs, FlowProducer → README "Offen" (Task 5 Step 6) ✓

**Placeholder-Scan:** Kein TBD/TODO; jeder Code-Step enthält vollständigen Code, jeder Run-Step ein erwartetes Ergebnis. ✓

**Type-Konsistenz:** `ScheduleInput`/`ScheduleRecord` (Task 1) durchgängig genutzt; `createSchedule`, `listSchedules`, `listActiveSchedules`, `deleteSchedule`, `getSchedule` einheitlich benannt zwischen store.ts, sync.ts und api/index.ts; `upsertScheduler`/`removeScheduler` (Task 3) mit `SchedulerQueue` matchen die Aufrufe in Task 4/5; `job.data`-Form in sync.ts (`{payload, consumer, tenant, callbackUrl}`) identisch zum bestehenden `POST /jobs` und zum Worker-Reader `job.data?.payload`. ✓

**Bekannte Grenze:** Wird ein Schedule in der DB auf `active=false` gesetzt ohne DELETE, bleibt der BullMQ-Scheduler bis zum nächsten Redeploy bestehen — im Tracer kein Pfad dorthin (kein Update-Endpoint), daher akzeptiert.
