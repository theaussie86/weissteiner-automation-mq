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
