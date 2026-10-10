import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPinterestClient, PinterestApiError, type PinterestVideoRegistration } from "./pinterest.js";

describe("createPinterestClient createPin", () => {
  it("postet nach /v5/pins und liefert die id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "42" }), { status: 201 }));
    const client = createPinterestClient(fetchMock as unknown as typeof fetch);
    const result = await client.createPin("tok", {
      board_id: "b",
      media_source: { source_type: "image_url", url: "https://img" },
    });
    expect(result).toEqual({ id: "42" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.pinterest.com/v5/pins");
  });

  it("Fehlerantwort => PinterestApiError mit Status und Body-Message", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "bad" }), { status: 400 }));
    const client = createPinterestClient(fetchMock as unknown as typeof fetch);
    const err = await client
      .createPin("tok", { board_id: "b", media_source: { source_type: "image_url", url: "https://img" } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PinterestApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Pinterest API error: bad");
  });
});

describe("createPinterestClient registerVideoMedia", () => {
  it("postet media_type video und mappt die S3-Daten", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ media_id: "m1", upload_url: "https://s3.example/up", upload_parameters: { key: "k" } }),
          { status: 201 },
        ),
    );
    const client = createPinterestClient(fetchMock as unknown as typeof fetch);
    const reg = await client.registerVideoMedia("tok");
    expect(reg).toEqual({ mediaId: "m1", uploadUrl: "https://s3.example/up", uploadParameters: { key: "k" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.pinterest.com/v5/media");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ media_type: "video" });
  });
});

describe("createPinterestClient uploadVideoToS3", () => {
  const reg: PinterestVideoRegistration = {
    mediaId: "m1",
    uploadUrl: "https://s3.example/up",
    uploadParameters: { key: "k", policy: "p", "x-amz-signature": "sig" },
  };

  async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "pin-vid-"));
    const path = join(dir, "clip.mp4");
    await writeFile(path, Buffer.from("video-bytes"));
    try {
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("multipart: erst alle upload_parameters, zuletzt das Feld file", async () => {
    await withTempFile(async (path) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      const client = createPinterestClient(fetchMock as unknown as typeof fetch);
      await client.uploadVideoToS3(reg, path);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://s3.example/up");
      expect((init as RequestInit).method).toBe("POST");
      const form = (init as RequestInit).body as FormData;
      expect([...form.keys()]).toEqual(["key", "policy", "x-amz-signature", "file"]);
    });
  });

  it("S3-Fehler => PinterestApiError mit Status", async () => {
    await withTempFile(async (path) => {
      const fetchMock = vi.fn(async () => new Response("denied", { status: 403 }));
      const client = createPinterestClient(fetchMock as unknown as typeof fetch);
      const err = await client.uploadVideoToS3(reg, path).catch((e) => e);
      expect(err).toBeInstanceOf(PinterestApiError);
      expect(err.status).toBe(403);
    });
  });
});

describe("createPinterestClient getMediaStatus", () => {
  it("GET /v5/media/{id} liefert den Status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "succeeded" }), { status: 200 }));
    const client = createPinterestClient(fetchMock as unknown as typeof fetch);
    const status = await client.getMediaStatus("tok", "m1");
    expect(status).toBe("succeeded");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.pinterest.com/v5/media/m1");
  });
});
