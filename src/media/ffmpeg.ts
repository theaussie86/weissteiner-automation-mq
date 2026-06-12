import { spawn } from "node:child_process";

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

// Legacy-Defaults aus dem ffmpeg-docker-api (DEFAULT_COMPRESSION_CONFIG)
export const AUDIO_DEFAULTS = {
  codec: "libmp3lame",
  bitrate: "128k",
  sampleRate: 22050,
  channels: 2,
  quality: 2,
} as const;

export interface AudioOptions {
  bitrate?: string | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
  quality?: number | undefined;
}

export interface ThumbnailOptions {
  second?: number | undefined;
  format?: "jpeg" | "png" | undefined;
  quality?: number | undefined;
}

export function buildAudioArgs(inputPath: string, outputPath: string, opts: AudioOptions = {}): string[] {
  const cfg = {
    codec: AUDIO_DEFAULTS.codec,
    bitrate: opts.bitrate ?? AUDIO_DEFAULTS.bitrate,
    sampleRate: opts.sampleRate ?? AUDIO_DEFAULTS.sampleRate,
    channels: opts.channels ?? AUDIO_DEFAULTS.channels,
    quality: opts.quality ?? AUDIO_DEFAULTS.quality,
  };
  return [
    "-i", inputPath,
    "-vn",
    "-acodec", cfg.codec,
    "-ab", cfg.bitrate,
    "-ar", String(cfg.sampleRate),
    "-ac", String(cfg.channels),
    "-q:a", String(cfg.quality),
    "-y", outputPath,
  ];
}

export function buildThumbnailArgs(inputPath: string, outputPath: string, opts: ThumbnailOptions = {}): string[] {
  const { second = 1, format = "jpeg", quality = 3 } = opts;
  const args = ["-ss", String(second), "-i", inputPath, "-frames:v", "1", "-an"];
  if (format === "jpeg") {
    args.push("-q:v", String(quality), "-f", "image2", "-vcodec", "mjpeg");
  } else {
    args.push("-f", "image2", "-vcodec", "png");
  }
  args.push("-y", outputPath);
  return args;
}

// Fehler-Pattern-Mapping aus dem Legacy-Dienst
function mapStderr(stderr: string): FfmpegError {
  if (stderr.includes("Invalid data found when processing input")) {
    return new FfmpegError("Invalid or corrupted input file", "INVALID_INPUT");
  }
  if (stderr.includes("Unknown encoder")) {
    return new FfmpegError("Unsupported codec", "UNSUPPORTED_CODEC");
  }
  if (/Output file.*does not contain any stream/i.test(stderr)) {
    return new FfmpegError("Requested frame is beyond end of video", "OUT_OF_RANGE");
  }
  if (stderr.includes("No space left")) {
    return new FfmpegError("Insufficient disk space", "DISK_FULL");
  }
  return new FfmpegError("FFmpeg failed", "FFMPEG_FAILED");
}

export function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new FfmpegError(`FFmpeg timeout after ${timeoutMs / 1000}s`, "TIMEOUT"));
    }, timeoutMs);
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(mapStderr(stderr));
    });
    proc.on("error", () => {
      clearTimeout(timer);
      reject(new FfmpegError("FFmpeg process failed to start", "PROCESS_ERROR"));
    });
  });
}

export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => {
      const duration = parseFloat(out.trim());
      resolve(code === 0 && !Number.isNaN(duration) ? duration : 0);
    });
    proc.on("error", () => resolve(0));
  });
}
