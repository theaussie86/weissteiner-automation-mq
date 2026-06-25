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
