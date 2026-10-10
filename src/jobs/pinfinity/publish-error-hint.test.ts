import { describe, expect, it } from "vitest";
import { withActionHint } from "./publish-error-hint.js";

describe("withActionHint", () => {
  it("hängt die Anweisung an die Roh-Meldung", () => {
    const out = withActionHint("Pin must have a Pinterest board assigned");
    expect(out.startsWith("Pin must have a Pinterest board assigned - Was tun: ")).toBe(true);
    expect(out).toContain("Board");
  });

  it("erkennt Video-Pflicht", () => {
    expect(withActionHint("Pin must have a video")).toContain("Video hochladen");
  });

  it("erkennt den Spaltenfehler", () => {
    expect(withActionHint("Supabase-Query fehlgeschlagen: column pins.video_path does not exist")).toContain(
      "Pinfinity-Betreuung",
    );
  });

  it("nutzt den HTTP-Status, wenn die Meldung nichts hergibt", () => {
    expect(withActionHint("x", 429)).toContain("später");
    expect(withActionHint("x", 401)).toContain("neu verbinden");
  });

  it("Fallback bei unbekanntem Fehler", () => {
    expect(withActionHint("völlig unbekannt")).toContain("Pin-Daten prüfen");
  });

  it("ist idempotent", () => {
    const once = withActionHint("Pin must have a video");
    expect(withActionHint(once)).toBe(once);
  });
});
