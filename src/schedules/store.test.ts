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
