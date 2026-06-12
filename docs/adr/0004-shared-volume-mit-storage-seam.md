# Shared Docker Volume mit Storage-Seam statt Objekt-Storage

Ergebnis-Dateien laufen über ein gemeinsames Docker Volume zwischen Worker- und API-Container (Single-VPS, einfachster Weg); ein BullMQ-Repeatable-Job räumt abgelaufene Dateien. Der Dateizugriff liegt aber hinter einem eigenen Storage-Modul (Seam), sodass ein späterer Wechsel auf Objekt-Storage (S3/MinIO/Supabase Storage, presigned URLs) bei Multi-Host-Betrieb ein Adapter-Tausch ist. Bewusst nur ein Adapter heute — der Wechselgrund (Verlassen des Single-Host) ist konkret absehbar.
