import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024; // wie Legacy-Dienst

export interface DownloadedFile {
  path: string;
  cleanup: () => Promise<void>;
}

export async function downloadToTempFile(url: string): Promise<DownloadedFile> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Source file too large: ${contentLength} bytes (max ${MAX_DOWNLOAD_BYTES})`);
  }

  const dir = await mkdtemp(join(tmpdir(), "mq-dl-"));
  const path = join(dir, "input");
  let received = 0;
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) {
        cb(new Error(`Source file too large: exceeded ${MAX_DOWNLOAD_BYTES} bytes while streaming`));
        return;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body as never), sizeGuard, createWriteStream(path));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
