import { createHmac, timingSafeEqual } from "node:crypto";

// Temp-URL (CONTEXT.md): signierte, ablaufende URL für Ergebnis-Dateien.
// HMAC über "key:exp" — API und Worker teilen URL_SIGNING_SECRET via Env.

function sign(secret: string, fileKey: string, exp: number): string {
  return createHmac("sha256", secret).update(`${fileKey}:${exp}`).digest("hex");
}

export function createTempUrl(opts: {
  baseUrl: string;
  secret: string;
  fileKey: string;
  ttlSeconds?: number;
  now?: number;
}): string {
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + (opts.ttlSeconds ?? 24 * 3600);
  const sig = sign(opts.secret, opts.fileKey, exp);
  return `${opts.baseUrl}/files/${encodeURIComponent(opts.fileKey)}?exp=${exp}&sig=${sig}`;
}

export function verifyTempUrl(opts: {
  secret: string;
  fileKey: string;
  exp: number;
  sig: string;
  now?: number;
}): { valid: boolean; reason?: "expired" | "bad-signature" } {
  if (Math.floor((opts.now ?? Date.now()) / 1000) > opts.exp) {
    return { valid: false, reason: "expired" };
  }
  const expected = Buffer.from(sign(opts.secret, opts.fileKey, opts.exp));
  const given = Buffer.from(opts.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: "bad-signature" };
  }
  return { valid: true };
}
