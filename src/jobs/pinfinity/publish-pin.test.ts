import { describe, expect, it, vi } from "vitest";
import { DelayedError, UnrecoverableError } from "bullmq";
import type { RateLimitContext } from "./rate-limit.js";
import {
  buildAiDisclosures,
  handlePublishPinFinalFailure,
  publishPin,
  type PinStore,
  type PublishablePin,
  type PublishPinPayload,
} from "./publish-pin.js";
import { PinterestApiError, type PinterestClient } from "../../integrations/pinterest.js";

const SCHEDULED_AT = "2026-10-10T12:00:00.000Z";

function basePin(overrides: Partial<PublishablePin> = {}): PublishablePin {
  return {
    id: "pin-1",
    status: "metadata_created",
    scheduled_at: SCHEDULED_AT,
    pinterest_pin_id: null,
    pinterest_board_id: "board-9",
    image_path: "proj/img.jpg",
    title: "Titel",
    description: "Beschreibung",
    alt_text: "Alt",
    alternate_url: null,
    article_url: "https://blog.example/post",
    connection_id: "conn-7",
    ai_modified: true,
    synthetic_performer: false,
    ...overrides,
  };
}

function fakeStore(
  pin: PublishablePin | null,
  opts: {
    token?: Awaited<ReturnType<PinStore["getAccessToken"]>>;
    markPublishedErrors?: (string | null)[];
  } = {},
) {
  const markResults = opts.markPublishedErrors ?? [null];
  let markCall = 0;
  const markPublished = vi.fn(async () => {
    const error = markResults[Math.min(markCall, markResults.length - 1)] ?? null;
    markCall++;
    return { error };
  });
  const deactivateConnection = vi.fn(async () => {});
  const markErrorIfPending = vi.fn(async () => {});
  const store: PinStore = {
    loadPin: async () => pin,
    getAccessToken: async () => opts.token ?? { ok: true, token: "tok" },
    publicImageUrl: (p) => `https://sb.example/storage/v1/object/public/pin-images/${p}`,
    markPublished,
    deactivateConnection,
    markErrorIfPending,
  };
  return { store, markPublished, deactivateConnection, markErrorIfPending };
}

function fakePinterest(behaviour: () => Promise<{ id: string }>): {
  client: PinterestClient;
  createPin: ReturnType<typeof vi.fn>;
} {
  const createPin = vi.fn(behaviour);
  return { client: { createPin }, createPin };
}

const noSleep = { sleep: async () => {}, now: () => new Date(SCHEDULED_AT) };

describe("publishPin stale-guard", () => {
  it("pin fehlt => skipped", async () => {
    const { store } = fakeStore(null);
    const { client, createPin } = fakePinterest(async () => ({ id: "x" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(result).toEqual({ skipped: "pin not found" });
    expect(createPin).not.toHaveBeenCalled();
  });

  it("status != metadata_created => skipped", async () => {
    const { store } = fakeStore(basePin({ status: "published" }));
    const { client, createPin } = fakePinterest(async () => ({ id: "x" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(result).toEqual({ skipped: "status is published" });
    expect(createPin).not.toHaveBeenCalled();
  });

  it("pinterest_pin_id gesetzt => skipped", async () => {
    const { store } = fakeStore(basePin({ pinterest_pin_id: "already" }));
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(result).toEqual({ skipped: "already has pinterest_pin_id" });
  });

  it("scheduled_at weicht ab => skipped", async () => {
    const { store } = fakeStore(basePin({ scheduled_at: "2026-01-01T00:00:00.000Z" }));
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(result).toEqual({ skipped: "scheduled_at changed" });
  });
});

describe("publishPin Pflichtfelder (unrecoverable)", () => {
  it("fehlende Connection", async () => {
    const { store } = fakeStore(basePin({ connection_id: null }));
    const { client } = fakePinterest(async () => ({ id: "x" }));
    await expect(publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep)).rejects.toThrow(
      new UnrecoverableError("No Pinterest account connected to this project"),
    );
  });

  it("fehlendes Board", async () => {
    const { store } = fakeStore(basePin({ pinterest_board_id: null }));
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pin must have a Pinterest board assigned");
  });

  it("fehlendes Bild", async () => {
    const { store } = fakeStore(basePin({ image_path: null }));
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pin must have an image");
  });
});

describe("publishPin Token-RPC", () => {
  it("retryable => normaler Error (Retry)", async () => {
    const { store } = fakeStore(basePin({}), { token: { ok: false, retryable: true, message: "net down" } });
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("net down");
  });

  it("nicht retryable => Unrecoverable", async () => {
    const { store } = fakeStore(basePin({}), { token: { ok: false, retryable: false, message: "no token" } });
    const { client } = fakePinterest(async () => ({ id: "x" }));
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("no token");
  });
});

describe("publishPin Erfolgspfad", () => {
  it("baut Payload (Trunkierung, link, ai_disclosures) und schreibt DB", async () => {
    const pin = basePin({
      title: "T".repeat(150),
      description: "D".repeat(900),
      alt_text: "A".repeat(600),
      alternate_url: null,
      article_url: "https://blog.example/post",
      ai_modified: true,
      synthetic_performer: true,
    });
    const { store, markPublished } = fakeStore(pin);
    const { client, createPin } = fakePinterest(async () => ({ id: "99" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);

    expect(result).toEqual({ published: true, pinterestPinId: "99" });
    expect(createPin).toHaveBeenCalledWith("tok", {
      board_id: "board-9",
      media_source: { source_type: "image_url", url: "https://sb.example/storage/v1/object/public/pin-images/proj/img.jpg" },
      title: "T".repeat(100),
      description: "D".repeat(800),
      alt_text: "A".repeat(500),
      link: "https://blog.example/post",
      ai_disclosures: { values: ["AI_MODIFIED", "SYNTHETIC_PERFORMER"] },
    });
    expect(markPublished).toHaveBeenCalledWith("pin-1", {
      pinterestPinId: "99",
      pinterestPinUrl: "https://www.pinterest.com/pin/99/",
      publishedAt: SCHEDULED_AT,
    });
  });

  it("alternate_url hat Vorrang vor article_url", async () => {
    const { store } = fakeStore(basePin({ alternate_url: "https://alt.example" }));
    const { client, createPin } = fakePinterest(async () => ({ id: "1" }));
    await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(createPin.mock.calls[0][1].link).toBe("https://alt.example");
  });
});

describe("publishPin Pinterest-Fehlerklassifikation", () => {
  const run = (store: PinStore, client: PinterestClient) =>
    publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);

  it("429 => Retry (kein UnrecoverableError)", async () => {
    const { store } = fakeStore(basePin({}));
    const { client } = fakePinterest(async () => {
      throw new PinterestApiError(429, "rate limited");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(PinterestApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("503 => Retry", async () => {
    const { store } = fakeStore(basePin({}));
    const { client } = fakePinterest(async () => {
      throw new PinterestApiError(503, "down");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(PinterestApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("Netzwerkfehler => Retry (propagiert)", async () => {
    const { store } = fakeStore(basePin({}));
    const { client } = fakePinterest(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(TypeError);
  });

  it("400 => Unrecoverable", async () => {
    const { store } = fakeStore(basePin({}));
    const { client } = fakePinterest(async () => {
      throw new PinterestApiError(400, "bad request");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pinterest API error: bad request");
  });

  it("403 => Unrecoverable, Connection unberührt", async () => {
    const { store, deactivateConnection } = fakeStore(basePin({}));
    const { client } = fakePinterest(async () => {
      throw new PinterestApiError(403, "forbidden");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(deactivateConnection).not.toHaveBeenCalled();
  });

  it("401 => Connection inaktiv und Unrecoverable", async () => {
    const { store, deactivateConnection } = fakeStore(basePin({ connection_id: "conn-7" }));
    const { client } = fakePinterest(async () => {
      throw new PinterestApiError(401, "unauthorized");
    });
    const err = await run(store, client);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(deactivateConnection).toHaveBeenCalledWith("conn-7");
  });
});

describe("publishPin Doppel-Post-Schutz", () => {
  it("DB-Update schlägt dauerhaft fehl => Unrecoverable nach 3 Versuchen", async () => {
    const { store, markPublished } = fakeStore(basePin({}), { markPublishedErrors: ["boom", "boom", "boom"] });
    const { client } = fakePinterest(async () => ({ id: "77" }));
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pin auf Pinterest angelegt (77), DB-Update fehlgeschlagen");
    expect(markPublished).toHaveBeenCalledTimes(3);
  });

  it("DB-Update klappt beim zweiten Versuch", async () => {
    const { store, markPublished } = fakeStore(basePin({}), { markPublishedErrors: ["boom", null] });
    const { client } = fakePinterest(async () => ({ id: "77" }));
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, noSleep);
    expect(result).toEqual({ published: true, pinterestPinId: "77" });
    expect(markPublished).toHaveBeenCalledTimes(2);
  });
});

describe("publishPin Rate-Limit pro Connection (Ticket #13)", () => {
  function fakeRateLimit(opts: { busy: boolean; remainingMs?: number }): {
    rateLimit: RateLimitContext;
    defer: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  } {
    const set = vi.fn(async () => (opts.busy ? null : "OK"));
    const defer = vi.fn(async (): Promise<never> => {
      // Wie im Worker: verschobener Job wirft DelayedError (kein Attempt verbraucht).
      throw new DelayedError();
    });
    const rateLimit: RateLimitContext = {
      redis: { set, pttl: async () => opts.remainingMs ?? 4000 },
      defer,
      random: () => 0,
    };
    return { rateLimit, defer, set };
  }

  it("Marke frei => postet normal, Marke wird pro Connection belegt", async () => {
    const { store, markPublished } = fakeStore(basePin({}));
    const { client, createPin } = fakePinterest(async () => ({ id: "55" }));
    const { rateLimit, defer, set } = fakeRateLimit({ busy: false });
    const result = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, rateLimit });

    expect(result).toEqual({ published: true, pinterestPinId: "55" });
    expect(set).toHaveBeenCalledWith("pinterest-rl-conn-7", "1", "PX", 10_000, "NX");
    expect(defer).not.toHaveBeenCalled();
    expect(createPin).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledTimes(1);
  });

  it("Marke belegt => Job verschiebt sich (DelayedError), postet nicht", async () => {
    const { store, markPublished } = fakeStore(basePin({}));
    const { client, createPin } = fakePinterest(async () => ({ id: "55" }));
    const { rateLimit, defer } = fakeRateLimit({ busy: true, remainingMs: 7000 });
    const err = await publishPin(store, client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, rateLimit }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(DelayedError);
    expect(defer).toHaveBeenCalledWith(7000);
    expect(createPin).not.toHaveBeenCalled();
    expect(markPublished).not.toHaveBeenCalled();
  });
});

describe("handlePublishPinFinalFailure", () => {
  const payload: PublishPinPayload = {
    supabaseCredential: "pinfinity-supabase",
    pinId: "pin-1",
    scheduledAt: SCHEDULED_AT,
    resendCredential: "pinfinity-resend",
  };

  it("setzt Pin auf error und reiht die Mail ein", async () => {
    const { store, markErrorIfPending } = fakeStore(basePin({}));
    const enqueue = vi.fn(async () => ({ outcome: "enqueued" as const, job: { getState: async () => "waiting", remove: async () => {} } }));
    await handlePublishPinFinalFailure(store, payload, new Error("kaputt"), enqueue, "job-42");

    expect(markErrorIfPending).toHaveBeenCalledWith("pin-1", "kaputt");
    expect(enqueue).toHaveBeenCalledWith(
      "pinfinity.send-publish-error-mail",
      { supabaseCredential: "pinfinity-supabase", resendCredential: "pinfinity-resend", pinId: "pin-1", errorMessage: "kaputt" },
      { jobId: "publish-error-mail-pin-1-job-42" },
    );
  });
});

describe("buildAiDisclosures", () => {
  it("beides false => undefined", () => {
    expect(buildAiDisclosures(false, false)).toBeUndefined();
  });
  it("nur ai_modified => AI_MODIFIED", () => {
    expect(buildAiDisclosures(true, false)).toEqual({ values: ["AI_MODIFIED"] });
  });
  it("synthetic_performer impliziert AI_MODIFIED", () => {
    expect(buildAiDisclosures(false, true)).toEqual({ values: ["AI_MODIFIED", "SYNTHETIC_PERFORMER"] });
  });
});
