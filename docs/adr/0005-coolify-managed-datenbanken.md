# Postgres und Redis als Coolify-Services, App-Container stateless aus dem Repo

Postgres und Redis laufen als Coolify-managed Services (automatische Backups, Volumes, Restarts) auf dem bestehenden Hostinger-VPS; das Repo deployt nur die stateless API- und Worker-Container. Ein Deploy kann die Datenbanken damit nie anfassen. Deploy-Gate: Coolify deployt nur `main`, Branch Protection verlangt grünes CI (Vitest Unit/Integration mit Service-Containern, E2E gegen gebautes Image).
