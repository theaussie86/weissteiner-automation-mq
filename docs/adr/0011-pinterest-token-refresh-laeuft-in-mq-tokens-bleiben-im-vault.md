# Pinterest-Token-Refresh läuft in MQ, die Tokens bleiben im Vault

Der Refresh der Pinterest-Tokens (bisher Edge Function `refresh-pinterest-tokens`, ausgelöst per pg_cron) läuft jetzt als MQ-Job `pinfinity.refresh-pinterest-tokens` (Queue `integrations`). Das ergänzt ADR-0009: Die **Ausführung** zieht nach MQ, die **Source of Truth** bleibt Supabase Vault, weil die Web-App die Tokens weiter direkt liest.

## Entscheidungen

- **Zugriff:** Der Job nutzt das Credential `pinfinity-supabase` (Service-Role) und die RPCs `get_pinterest_refresh_token` und `store_pinterest_tokens`. Tokens werden in MQ nie persistiert.
- **Pinterest-App:** Client-ID und Secret liegen als `apikey`-Credential (`{clientId, clientSecret}`) im Store, nicht als Env und nicht als neuer Provider. Der Job-Payload nennt sie über `pinterestAppCredential`.
- **Horizont:** Connections mit `is_active` und Ablauf in weniger als 7 Tagen, wie in der Edge Function.
- **Fehlerverhalten ändert sich:** Nur persistente Pinterest-Fehler (4xx außer 429, z.B. `invalid_grant`) deaktivieren die Connection. 5xx, 429, Netzwerk- und Vault-Fehler setzen nur `last_error` und werden beim nächsten Lauf erneut versucht. Die Edge Function hat bei jedem Fehler deaktiviert, auch bei einem Pinterest-Ausfall.
- **Ergebnis:** Der Job wirft nie wegen einzelner Connections, sondern liefert `{total, refreshed, failed, dryRun, details}`. `dryRun` zählt nur.

## Consequences

- Cutover: Credential `pinfinity-pinterest-app` anlegen, Schedule anlegen (`dryRun: true` zuerst), danach pg_cron-Job und Edge Function in Pinfinity abschalten. Beide parallel zu betreiben ist riskant, weil Pinterest den Refresh-Token bei einem Refresh rotieren kann.
- Die RPCs müssen für die Service-Role ausführbar sein (live prüfen).
- Fehlgeschlagene Refreshs lösen keine Mail aus. Sichtbar sind sie in `last_error`, im Job-Ergebnis und im Log.
