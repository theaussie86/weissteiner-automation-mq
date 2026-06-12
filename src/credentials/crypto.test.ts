import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential } from "./crypto.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const otherKey = Buffer.alloc(32, 9).toString("base64");
const data = { accessToken: "ya29.abc", refreshToken: "1//xyz", scopes: ["a"] };

describe("credential crypto", () => {
  it("roundtrips data", () => {
    const blob = encryptCredential(masterKey, "google-wachmacherei", data);
    expect(decryptCredential(masterKey, "google-wachmacherei", blob)).toEqual(data);
  });

  it("produces different ciphertext per call (random IV)", () => {
    const a = encryptCredential(masterKey, "n", data);
    const b = encryptCredential(masterKey, "n", data);
    expect(a.equals(b)).toBe(false);
  });

  it("fails with wrong key", () => {
    const blob = encryptCredential(masterKey, "n", data);
    expect(() => decryptCredential(otherKey, "n", blob)).toThrow();
  });

  it("fails when name does not match (AAD-Bindung)", () => {
    const blob = encryptCredential(masterKey, "google-a", data);
    expect(() => decryptCredential(masterKey, "google-b", blob)).toThrow();
  });
});
