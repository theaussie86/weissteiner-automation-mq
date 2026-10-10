import { describe, expect, it, vi } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  recordPublishEvent,
  type PublishEventRow,
  type PublishEventStore,
} from "./publish-events.js";

function fakeStore(opts: { insertError?: string } = {}): {
  store: PublishEventStore;
  insert: ReturnType<typeof vi.fn>;
} {
  const insert = vi.fn(async (_row: PublishEventRow) => {
    if (opts.insertError) throw new Error(opts.insertError);
  });
  return { store: { insertEvent: insert }, insert };
}

describe("recordPublishEvent", () => {
  it("schreiben gelingt: zeile korrekt auf db-spalten gemappt", async () => {
    const { store, insert } = fakeStore();
    await recordPublishEvent(store, {
      pinId: "pin-1",
      blogProjectId: "proj-1",
      type: "succeeded",
      attempt: 2,
      maxAttempts: 4,
      message: "Pin veröffentlicht",
      details: { pinterest_pin_id: "123", job_id: "publish-pin-pin-1" },
    });
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith({
      pin_id: "pin-1",
      blog_project_id: "proj-1",
      event_type: "succeeded",
      attempt: 2,
      max_attempts: 4,
      message: "Pin veröffentlicht",
      details: { pinterest_pin_id: "123", job_id: "publish-pin-pin-1" },
    } satisfies PublishEventRow);
  });

  it("mail_sent ohne attempt/maxAttempts: null gespeichert", async () => {
    const { store, insert } = fakeStore();
    await recordPublishEvent(store, {
      pinId: "pin-1",
      blogProjectId: "proj-1",
      type: "mail_sent",
      details: { recipient: "a@b.de" },
    });
    const row = insert.mock.calls[0][0] as PublishEventRow;
    expect(row.attempt).toBeNull();
    expect(row.max_attempts).toBeNull();
    expect(row.message).toBeNull();
  });

  it("schreibfehler wird verschluckt und geloggt", async () => {
    const { store, insert } = fakeStore({ insertError: "db down" });
    const log = vi.fn();
    await expect(
      recordPublishEvent(
        store,
        { pinId: "pin-1", blogProjectId: "proj-1", type: "failed_final" },
        log,
      ),
    ).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    const line = JSON.parse(log.mock.calls[0][0] as string);
    expect(line).toMatchObject({ event: "recordPublishEvent.error", pinId: "pin-1", type: "failed_final", error: "db down" });
  });

  it("kürzung: message länger als 500 zeichen wird gekürzt", async () => {
    const { store, insert } = fakeStore();
    await recordPublishEvent(store, {
      pinId: "pin-1",
      blogProjectId: "proj-1",
      type: "retry_scheduled",
      message: "x".repeat(600),
    });
    const row = insert.mock.calls[0][0] as PublishEventRow;
    expect(row.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("kein secret in details: token-werte und bearer-strings werden redigiert", async () => {
    const { store, insert } = fakeStore();
    await recordPublishEvent(store, {
      pinId: "pin-1",
      blogProjectId: "proj-1",
      type: "failed_final",
      details: {
        http_status: 401,
        access_token: "pina_AMA7secretvalue123456",
        error_class: "unrecoverable",
        nested: { authorization: "Bearer abc.def.ghi", note: "Bearer pina_leaked0987654321" },
      },
    });
    const row = insert.mock.calls[0][0] as PublishEventRow;
    const flat = JSON.stringify(row.details);
    expect(flat).not.toContain("pina_AMA7secretvalue123456");
    expect(flat).not.toContain("abc.def.ghi");
    expect(flat).not.toContain("pina_leaked0987654321");
    // Harmlose Felder bleiben erhalten.
    expect(row.details.http_status).toBe(401);
    expect(row.details.error_class).toBe("unrecoverable");
  });

  it("kein secret in message: zugriffstoken im fehlertext wird redigiert", async () => {
    const { store, insert } = fakeStore();
    await recordPublishEvent(store, {
      pinId: "pin-1",
      blogProjectId: "proj-1",
      type: "retry_scheduled",
      message: "Pinterest 401 mit Authorization: Bearer pina_AMA7secretvalue123456",
    });
    const row = insert.mock.calls[0][0] as PublishEventRow;
    expect(row.message).not.toContain("pina_AMA7secretvalue123456");
  });
});
