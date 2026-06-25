import { describe, expect, it } from "vitest";
import { isCronShape, isValidTimezone } from "./validate.js";

describe("schedule validation", () => {
  it("akzeptiert 5- und 6-feld-cron", () => {
    expect(isCronShape("*/10 * * * *")).toBe(true);
    expect(isCronShape("0 9 * * 1-5")).toBe(true);
    expect(isCronShape("30 0 9 * * *")).toBe(true);
  });

  it("lehnt leere oder zu kurze cron-ausdruecke ab", () => {
    expect(isCronShape("")).toBe(false);
    expect(isCronShape("* * *")).toBe(false);
    expect(isCronShape("   ")).toBe(false);
  });

  it("erkennt gültige timezones", () => {
    expect(isValidTimezone("Europe/Vienna")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("lehnt unbekannte timezones ab", () => {
    expect(isValidTimezone("Mars/Phobos")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});
