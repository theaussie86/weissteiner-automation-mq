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
import {
  PinterestApiError,
  type PinterestClient,
  type PinterestMediaStatus,
  type PinterestVideoRegistration,
} from "../../integrations/pinterest.js";

const SCHEDULED_AT = "2026-10-10T12:00:00.000Z";

function basePin(overrides: Partial<PublishablePin> = {}): PublishablePin {
  return {
    id: "pin-1",
    status: "metadata_created",
    scheduled_at: SCHEDULED_AT,
    pinterest_pin_id: null,
    pinterest_board_id: "board-9",
    media_type: "image",
    image_path: "proj/img.jpg",
    video_path: null,
    cover_image_path: null,
    cover_keyframe_seconds: null,
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
    publicVideoUrl: (p) => `https://sb.example/storage/v1/object/public/pin-videos/${p}`,
    markPublished,
    deactivateConnection,
    markErrorIfPending,
  };
  return { store, markPublished, deactivateConnection, markErrorIfPending };
}

// Für Bild-Tests reicht createPin; die Video-Methoden werfen, falls versehentlich genutzt.
function fakePinterest(behaviour: () => Promise<{ id: string }>): {
  client: PinterestClient;
  createPin: ReturnType<typeof vi.fn>;
} {
  const createPin = vi.fn(behaviour);
  const notUsed = async (): Promise<never> => {
    throw new Error("video method not expected in this test");
  };
  return {
    client: {
      createPin,
      registerVideoMedia: notUsed,
      uploadVideoToS3: notUsed,
      getMediaStatus: notUsed,
    },
    createPin,
  };
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

describe("publishPin Video (Ticket #11)", () => {
  const DEFAULT_REG: PinterestVideoRegistration = {
    mediaId: "media-1",
    uploadUrl: "https://s3.example/upload",
    uploadParameters: { key: "k", policy: "p" },
  };

  function videoPin(overrides: Partial<PublishablePin> = {}): PublishablePin {
    return basePin({ media_type: "video", image_path: null, video_path: "proj/clip.mp4", ...overrides });
  }

  function fakeVideoPinterest(behaviour: {
    register?: () => Promise<PinterestVideoRegistration>;
    upload?: (reg: PinterestVideoRegistration, path: string) => Promise<void>;
    statuses?: PinterestMediaStatus[];
    create?: () => Promise<{ id: string }>;
  } = {}) {
    const registerVideoMedia = vi.fn(behaviour.register ?? (async () => DEFAULT_REG));
    const uploadVideoToS3 = vi.fn(behaviour.upload ?? (async () => {}));
    const statuses = behaviour.statuses ?? (["succeeded"] as PinterestMediaStatus[]);
    let statusCall = 0;
    const getMediaStatus = vi.fn(async () => statuses[Math.min(statusCall++, statuses.length - 1)]);
    const createPin = vi.fn(behaviour.create ?? (async () => ({ id: "vpin" })));
    const client: PinterestClient = { createPin, registerVideoMedia, uploadVideoToS3, getMediaStatus };
    return { client, registerVideoMedia, uploadVideoToS3, getMediaStatus, createPin };
  }

  function fakeDownload() {
    const cleanup = vi.fn(async () => {});
    const download = vi.fn(async () => ({ path: "/tmp/clip.mp4", cleanup }));
    return { download, cleanup };
  }

  it("Erfolgspfad: registriert, lädt hoch, pollt, legt Video-Pin an und räumt auf", async () => {
    const { store, markPublished } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({ statuses: ["registered", "processing", "succeeded"] });
    const { download, cleanup } = fakeDownload();
    const result = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download });

    expect(result).toEqual({ published: true, pinterestPinId: "vpin" });
    expect(pt.registerVideoMedia).toHaveBeenCalledWith("tok");
    expect(download).toHaveBeenCalledWith("https://sb.example/storage/v1/object/public/pin-videos/proj/clip.mp4");
    expect(pt.uploadVideoToS3).toHaveBeenCalledWith(DEFAULT_REG, "/tmp/clip.mp4");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(pt.getMediaStatus).toHaveBeenCalledTimes(3);
    expect(pt.createPin).toHaveBeenCalledWith("tok", {
      board_id: "board-9",
      media_source: { source_type: "video_id", media_id: "media-1", cover_image_key_frame_time: 1000 },
      title: "Titel",
      description: "Beschreibung",
      alt_text: "Alt",
      link: "https://blog.example/post",
      ai_disclosures: { values: ["AI_MODIFIED"] },
    });
    expect(markPublished).toHaveBeenCalledTimes(1);
  });

  it("Cover aus cover_image_path => cover_image_url", async () => {
    const { store } = fakeStore(videoPin({ cover_image_path: "proj/cover.jpg", cover_keyframe_seconds: 7 }));
    const pt = fakeVideoPinterest();
    const { download } = fakeDownload();
    await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download });
    expect(pt.createPin.mock.calls[0][1].media_source).toEqual({
      source_type: "video_id",
      media_id: "media-1",
      cover_image_url: "https://sb.example/storage/v1/object/public/pin-images/proj/cover.jpg",
    });
  });

  it("Cover-Keyframe: Sekunden werden zu Millisekunden", async () => {
    const { store } = fakeStore(videoPin({ cover_keyframe_seconds: 3 }));
    const pt = fakeVideoPinterest();
    const { download } = fakeDownload();
    await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download });
    expect(pt.createPin.mock.calls[0][1].media_source.cover_image_key_frame_time).toBe(3000);
  });

  it("fehlendes Video => Unrecoverable", async () => {
    const { store } = fakeStore(videoPin({ video_path: null }));
    const pt = fakeVideoPinterest();
    const { download } = fakeDownload();
    const err = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download }).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pin must have a video");
    expect(pt.registerVideoMedia).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("Registrierung 5xx => Retry, Video wird nicht geladen", async () => {
    const { store } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({
      register: async () => {
        throw new PinterestApiError(500, "server");
      },
    });
    const { download } = fakeDownload();
    const err = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download }).catch((e) => e);
    expect(err).toBeInstanceOf(PinterestApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(download).not.toHaveBeenCalled();
  });

  it("S3-Upload 5xx => Retry, Temp-Datei trotzdem gelöscht", async () => {
    const { store } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({
      upload: async () => {
        throw new PinterestApiError(503, "s3 down");
      },
    });
    const { download, cleanup } = fakeDownload();
    const err = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download }).catch((e) => e);
    expect(err).toBeInstanceOf(PinterestApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(pt.getMediaStatus).not.toHaveBeenCalled();
    expect(pt.createPin).not.toHaveBeenCalled();
  });

  it("S3-Upload 4xx => Unrecoverable, Temp-Datei gelöscht", async () => {
    const { store } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({
      upload: async () => {
        throw new PinterestApiError(400, "bad upload");
      },
    });
    const { download, cleanup } = fakeDownload();
    const err = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download }).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("Polling failed => Unrecoverable, kein Pin", async () => {
    const { store } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({ statuses: ["processing", "failed"] });
    const { download, cleanup } = fakeDownload();
    const err = await publishPin(store, pt.client, { pinId: "pin-1", scheduledAt: SCHEDULED_AT }, { ...noSleep, downloadVideo: download }).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Pinterest media processing failed");
    expect(pt.createPin).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("Polling-Timeout => Retry (normaler Error)", async () => {
    const { store } = fakeStore(videoPin());
    const pt = fakeVideoPinterest({ statuses: ["processing"] });
    const { download } = fakeDownload();
    let t = 1000;
    const err = await publishPin(
      store,
      pt.client,
      { pinId: "pin-1", scheduledAt: SCHEDULED_AT },
      { sleep: async () => {}, now: () => new Date((t += 10000)), downloadVideo: download, videoPollIntervalMs: 5000, videoPollTimeoutMs: 20000 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toContain("timed out");
    expect(pt.createPin).not.toHaveBeenCalled();
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
