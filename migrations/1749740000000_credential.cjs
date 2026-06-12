/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.createTable("credential", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "text", notNull: true, unique: true },
    provider: { type: "text", notNull: true },
    data_encrypted: { type: "bytea", notNull: true },
    token_expires_at: { type: "timestamptz" },
    status: { type: "text", notNull: true, default: "ok" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey')",
  });
  pgm.addConstraint("credential", "credential_status_check", {
    check: "status in ('ok', 'reauth_required')",
  });
  // Background-Refresh scannt ablaufende OAuth-Tokens — partieller Index reicht.
  pgm.createIndex("credential", "token_expires_at", { where: "token_expires_at IS NOT NULL" });
};

exports.down = (pgm) => {
  pgm.dropTable("credential");
};
