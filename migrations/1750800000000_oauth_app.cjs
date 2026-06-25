/* eslint-disable camelcase */

exports.up = (pgm) => {
  pgm.addColumn("credential", {
    parent_credential_id: {
      type: "uuid",
      references: "credential(id)",
      onDelete: "CASCADE",
    },
  });
  // Token-Rows zeigen auf ihre App-Row; Lookup beim Refresh über diesen FK.
  pgm.createIndex("credential", "parent_credential_id", {
    where: "parent_credential_id IS NOT NULL",
  });
  // Provider-Check um die App-Typen erweitern: erst alten Check droppen, dann neuen.
  pgm.dropConstraint("credential", "credential_provider_check");
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey', 'google-app', 'shopify-app')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint("credential", "credential_provider_check");
  pgm.addConstraint("credential", "credential_provider_check", {
    check: "provider in ('google', 'shopify', 'apikey')",
  });
  pgm.dropColumn("credential", "parent_credential_id");
};
