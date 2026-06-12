import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerJobType } from "./registry.js";
import { downloadToTempFile } from "../media/download.js";
import { buildAudioArgs, buildThumbnailArgs, probeDuration, runFfmpeg } from "../media/ffmpeg.js";
import { createVolumeStorage } from "../storage/index.js";
import { createTempUrl } from "../storage/temp-url.js";
import { loadConfig } from "../config.js";

const config = loadConfig();
const storage = createVolumeStorage(config.FILES_DIR);

function tempUrlFor(fileKey: string): string | null {
  if (!config.URL_SIGNING_SECRET || !config.PUBLIC_BASE_URL) return null;
  return createTempUrl({
    baseUrl: config.PUBLIC_BASE_URL,
    secret: config.URL_SIGNING_SECRET,
    fileKey,
  });
}

registerJobType({
  name: "media.extract-audio",
  queue: "media",
  payloadSchema: z.object({
    sourceUrl: z.string().url(),
    bitrate: z.string().regex(/^\d+k$/).optional(),
    sampleRate: z.coerce.number().int().positive().optional(),
    channels: z.coerce.number().int().min(1).max(2).optional(),
  }),
  process: async (payload) => {
    const source = await downloadToTempFile(payload.sourceUrl);
    const workDir = await mkdtemp(join(tmpdir(), "mq-ffmpeg-"));
    const outputPath = join(workDir, "output.mp3");
    try {
      await runFfmpeg(buildAudioArgs(source.path, outputPath, payload));
      const [duration, { size }] = await Promise.all([probeDuration(outputPath), stat(outputPath)]);
      const fileKey = `${randomUUID()}.mp3`;
      await storage.write(fileKey, await readFile(outputPath));
      return {
        fileKey,
        url: tempUrlFor(fileKey),
        contentType: "audio/mpeg",
        size,
        durationSeconds: duration,
      };
    } finally {
      await Promise.all([source.cleanup(), rm(workDir, { recursive: true, force: true })]);
    }
  },
});

registerJobType({
  name: "media.thumbnail",
  queue: "media",
  payloadSchema: z.object({
    sourceUrl: z.string().url(),
    second: z.coerce.number().min(0).optional(),
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.coerce.number().int().min(1).max(31).optional(),
  }),
  process: async (payload) => {
    const format = payload.format ?? "jpeg";
    const ext = format === "png" ? "png" : "jpg";
    const source = await downloadToTempFile(payload.sourceUrl);
    const workDir = await mkdtemp(join(tmpdir(), "mq-ffmpeg-"));
    const outputPath = join(workDir, `output.${ext}`);
    try {
      await runFfmpeg(buildThumbnailArgs(source.path, outputPath, payload), 30_000);
      const { size } = await stat(outputPath);
      if (size === 0) throw new Error("Thumbnail extraction produced empty file");
      const fileKey = `${randomUUID()}.${ext}`;
      await storage.write(fileKey, await readFile(outputPath));
      return {
        fileKey,
        url: tempUrlFor(fileKey),
        contentType: format === "png" ? "image/png" : "image/jpeg",
        size,
      };
    } finally {
      await Promise.all([source.cleanup(), rm(workDir, { recursive: true, force: true })]);
    }
  },
});
