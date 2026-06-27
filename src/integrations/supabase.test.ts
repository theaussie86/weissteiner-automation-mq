import { describe, expect, it } from "vitest";
import { createSupabaseClient } from "./supabase.js";

describe("createSupabaseClient", () => {
  it("wirft bei fehlender url", () => {
    expect(() => createSupabaseClient({ serviceRoleKey: "k" })).toThrow();
  });

  it("wirft bei leerem serviceRoleKey", () => {
    expect(() => createSupabaseClient({ url: "https://x.supabase.co", serviceRoleKey: "" })).toThrow();
  });

  it("wirft bei nicht-url", () => {
    expect(() => createSupabaseClient({ url: "kein-url", serviceRoleKey: "k" })).toThrow();
  });

  it("liefert einen client bei gültigen creds", () => {
    const client = createSupabaseClient({ url: "https://x.supabase.co", serviceRoleKey: "k" });
    expect(client).toBeDefined();
    expect(typeof client.from).toBe("function");
  });
});
