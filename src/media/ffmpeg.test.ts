import { describe, expect, it } from "vitest";
import { buildAudioArgs, buildThumbnailArgs } from "./ffmpeg.js";

describe("buildAudioArgs", () => {
  it("matches legacy default command", () => {
    expect(buildAudioArgs("/in.mp4", "/out.mp3")).toEqual([
      "-i", "/in.mp4",
      "-vn",
      "-acodec", "libmp3lame",
      "-ab", "128k",
      "-ar", "22050",
      "-ac", "2",
      "-q:a", "2",
      "-y", "/out.mp3",
    ]);
  });

  it("applies overrides", () => {
    const args = buildAudioArgs("/in.mp4", "/out.mp3", { bitrate: "64k", channels: 1 });
    expect(args).toContain("64k");
    expect(args[args.indexOf("-ac") + 1]).toBe("1");
  });
});

describe("buildThumbnailArgs", () => {
  it("seeks before input and limits to one frame", () => {
    const args = buildThumbnailArgs("/in.mp4", "/out.jpg", { second: 5 });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("5");
    expect(args).toContain("-frames:v");
    expect(args).toContain("mjpeg");
  });

  it("builds png variant without quality flag", () => {
    const args = buildThumbnailArgs("/in.mp4", "/out.png", { format: "png" });
    expect(args).toContain("png");
    expect(args).not.toContain("-q:v");
  });
});
