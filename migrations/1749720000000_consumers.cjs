/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable("consumer", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true, unique: true },
    key_hash: { type: "text", notNull: true, unique: true },
    queue_scopes: { type: "text[]", notNull: true },
    active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

exports.down = (pgm) => {
  pgm.dropTable("consumer");
};
