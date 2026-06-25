# App-geteilte Drittdienst-Tokens bleiben in Supabase Vault, MQ liest via Service-Role

Wenn ein Drittdienst-Token sowohl von einem MQ-Job als auch von der ursprünglichen Anwendung selbst gebraucht wird (Pinfinity: Pinterest-Token nutzen Auto-Publish-Job **und** das manuelle Publish in der Web-App), bleibt **Supabase Vault die Source of Truth**. Der MQ-Job zieht das Token im Ausführungsmoment über ein **Supabase-Service-Role-Credential** aus dem Credential Store (Provider `apikey`) — genau wie die heutige Edge Function `get_pinterest_access_token(connection_id)`. Das Token wird in MQ nie persistiert. Drittdienst-OAuth wird **nicht** in den Credential Store gespiegelt, solange die App weiter direkt darauf zugreift.

Begründung: Der Credential Store gibt per Design nie Klartext-Secrets über HTTP zurück (`GET /admin/credentials` listet ohne Secrets, Jobs lesen nur im Worker-Kontext). Würde der Store zur Source of Truth, müsste die App die Tokens dort abholen — das verlangt einen Endpoint, der entschlüsselte Tokens ausliefert, und durchbricht damit genau dieses Sicherheitsmodell. Solange ein zweiter Leser (die App) existiert, ist Vault als gemeinsame Quelle der kleinere, sichere Schnitt.

## Consequences

- MQ besitzt den Pinterest-OAuth-Refresh nicht; das bleibt bei der App/Vault, wo es heute funktioniert.
- Kein eigener `pinterest`-Provider im Credential Store nötig — der Migrations-Scope sinkt auf Supabase-apikey (existiert) plus die Job-Typen.
- Wird ein Token später **nur** noch von MQ gebraucht (App-Pfad abgeschaltet), kann es regulär in den Credential Store wandern — diese Entscheidung gilt nur für den geteilten Zustand.
