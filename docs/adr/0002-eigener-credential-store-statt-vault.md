# Eigener Credential Store in Postgres statt Vault/Infisical

Verbindungs-Credentials (Google-Konten, Shopify-Shops, Supabase-Instanzen, API-Keys) liegen AES-256-GCM-verschlüsselt in einer eigenen Postgres-Tabelle; ein Master-Key als App-Secret entschlüsselt (n8n-Modell). OAuth-Refresh wird zentral vom Store übernommen, nicht in einzelnen Jobs.

## Considered Options

- **HashiCorp Vault**: kann dynamische Secrets, aber operativ zu schwer für die erwartete Last.
- **Infisical/Doppler**: gut für statische App-Secrets, passt aber nicht zum dynamischen Wachstum von OAuth-Credentials zur Laufzeit.
- Statische App-Secrets (Redis-Passwort, Master-Key) laufen getrennt über Coolify/Env — bewusst zwei Mechanismen für zwei Konzepte.
