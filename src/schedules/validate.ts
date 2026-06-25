// Grobprüfung der Cron-Form: 5 (Standard) oder 6 (mit Sekunden) Felder.
// Die endgültige Pattern-Validierung macht BullMQ beim upsertJobScheduler.
export function isCronShape(cron: string): boolean {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 || fields.length === 6;
}

// Timezone gegen die Intl-Datenbank prüfen: unbekannte Zone wirft RangeError.
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
