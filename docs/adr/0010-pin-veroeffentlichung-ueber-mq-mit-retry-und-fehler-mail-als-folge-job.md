# Pin-Veröffentlichung über MQ mit Retry, Fehler-Mail als Folge-Job

Pinfinity veröffentlicht Pins nicht mehr per pg_cron und Edge Function, sondern über zwei MQ-Job-Typen: `pinfinity.publish-pin` (Queue `integrations`) und `pinfinity.send-publish-error-mail`. Pinfinity ist der Producer: Beim Speichern oder Ändern eines Pins mit `scheduled_at` reiht es einen verzögerten Job mit `jobId = publish-pin-<pinId>` ein (`onExisting: replace`), beim Löschen oder Entplanen bricht es ihn per `DELETE /jobs/:jobId` ab.

Gründe: Pinterest antwortet gelegentlich mit 5xx oder 429, die Edge Function hat keinen Retry, ein Pin blieb dann im Fehlerstatus. BullMQ liefert Delay, Retry mit Backoff und Sichtbarkeit im Board ohne Eigenbau.

## Entscheidungen

- **Retry-Policy pro Job-Typ:** `publish-pin` hat `attempts: 4` (1 Versuch plus 3 Retries), exponentielles Backoff ab 5 Minuten (5, 10, 20 min). `send-publish-error-mail` hat `attempts: 5` mit Backoff ab 1 Minute.
- **Retriable vs. unrecoverable:** 429, 5xx, Netzwerkfehler und Timeouts werden wiederholt. 400, 401, 403, 404 sowie fehlende Connection, fehlendes Board oder fehlendes Bild sind `UnrecoverableError` und scheitern sofort endgültig. Bei 401 wird die Connection auf inaktiv gesetzt.
- **Endgültiges Scheitern:** Archiv und Callback laufen nur noch dann (`isFinalFailure`), nicht pro Versuch. Der neue Hook `onFinalFailure` setzt den Pin auf `error` und reiht per `ctx.enqueue` den Mail-Job ein (`jobId = publish-error-mail-<pinId>-<jobId>`). Die Mail geht also erst nach dem letzten Retry oder bei einem nicht wiederholbaren Fehler raus.
- **Stale-Guard im Job:** Der Job vergleicht `scheduled_at` und Status mit dem aktuellen Pin und beendet sich ohne Wirkung, wenn der Pin geändert, veröffentlicht oder entplant wurde. Das schützt vor Race Conditions zwischen Ändern und Ausführen.
- **Double-Post-Schutz:** Schlägt das DB-Update nach erfolgreichem Pinterest-POST fehl, wird nicht erneut gepostet, sondern nur das Update wiederholt.
- **Rate-Limit:** 10 s Abstand pro Pinterest-Connection, per Redis und `moveToDelayed` (`DelayedError`), damit parallele Jobs derselben Connection sich nicht überholen.
- **Reconcile als Sicherheitsnetz:** `pinfinity.reconcile-publish-jobs` läuft als Schedule, reiht fehlende Jobs für Kandidaten (`status = metadata_created`, `scheduled_at` gesetzt, `pinterest_pin_id` null) mit `onExisting: skip` nach und füllt so auch den Bestand. Unterstützt `dryRun`.
- **Kein Callback nötig:** Der Worker schreibt das Ergebnis direkt in Pinfintys Supabase (Credential `pinfinity-supabase`, siehe ADR-0009). Das Pinterest-Token bleibt in Supabase Vault.

## Consequences

- Der pg_cron-Job `publish-scheduled-pins` muss vor dem Einreihen des Bestands deaktiviert werden, sonst gibt es Doppelposts. Cutover-Reihenfolge und Betrieb stehen in #15.
- Pinfinity braucht einen MQ-Client (`MQ_API_URL`, `MQ_API_KEY`) und synchronisiert den Job in allen Schreibpfaden.
- Die Mail geht über Resend (Credential `pinfinity-resend`). Der Drosselungsmechanismus `error_notified_at` aus Pinfinity entfällt für den MQ-Pfad, weil pro Pin und Job genau eine Mail eingereiht wird.
- Offen: das maximale sinnvolle BullMQ-Delay für weit in der Zukunft liegende Pins. Reconcile fängt Ausfälle ab, solange das ungeklärt ist.
