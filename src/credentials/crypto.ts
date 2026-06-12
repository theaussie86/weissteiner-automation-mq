import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM mit AAD = Credential-Name: bindet den Ciphertext an die Zeile,
// ein zwischen Zeilen getauschter Blob schlägt beim Auth-Tag-Check fehl (Spec, ADR-0002).
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptCredential(
  masterKeyB64: string,
  name: string,
  data: Record<string, unknown>,
): Buffer {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredential(
  masterKeyB64: string,
  name: string,
  blob: Buffer,
): Record<string, unknown> {
  const key = Buffer.from(masterKeyB64, "base64");
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(name, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}
