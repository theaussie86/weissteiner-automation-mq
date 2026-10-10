import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Erwartete Form einer Supabase-apikey-Credential im Store (ADR-0009).
const supabaseCredentialSchema = z.object({
  url: z.string().url(),
  serviceRoleKey: z.string().min(1),
});

// Baut einen service-role-Client aus einer Store-Credential. Validiert die Cred-Form,
// damit eine Fehlkonfiguration eine klare Meldung wirft statt eines obskuren SDK-Fehlers.
// Server-Kontext: keine Session-Persistenz, kein Auto-Refresh.
export function createSupabaseClient(credential: unknown): SupabaseClient {
  const parsed = supabaseCredentialSchema.parse(credential);
  return createClient(parsed.url, parsed.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
