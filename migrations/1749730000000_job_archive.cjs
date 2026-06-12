/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable("job_archive", {
    id: { type: "bigserial", primaryKey: true },
    job_id: { type: "text", notNull: true },
    queue: { type: "text", notNull: true },
    type: { type: "text", notNull: true },
    consumer: { type: "text", notNull: true },
    tenant: { type: "text" },
    status: { type: "text", notNull: true, default: "queued" },
    payload: { type: "jsonb" },
    result: { type: "jsonb" },
    error: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    finished_at: { type: "timestamptz" },
  });
  pgm.addConstraint("job_archive", "job_archive_queue_job_id_unique", { unique: ["queue", "job_id"] });
  pgm.createIndex("job_archive", "tenant");
  pgm.createIndex("job_archive", "consumer");
  pgm.createIndex("job_archive", "type");
  pgm.createIndex("job_archive", "status");
  pgm.createIndex("job_archive", "created_at");
};

exports.down = (pgm) => {
  pgm.dropTable("job_archive");
};
