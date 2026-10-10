import { describe, expect, it, vi } from "vitest";
import { cleanupPublishedImages, type CleanablePin, type CleanupClient } from "./cleanup.js";

function fakeClient(
  pins: CleanablePin[],
  opts: { removeError?: string; updateError?: string } = {},
): { client: CleanupClient; remove: ReturnType<typeof vi.fn>; nullPaths: ReturnType<typeof vi.fn> } {
  const remove = vi.fn(async () => ({ error: opts.removeError ?? null }));
  const nullPaths = vi.fn(async () => ({ error: opts.updateError ?? null }));
  const client: CleanupClient = {
    listCleanablePins: async () => pins,
    removeImages: remove,
    nullImagePaths: nullPaths,
  };
  return { client, remove, nullPaths };
}

const twoPins: CleanablePin[] = [
  { id: "p1", image_path: "a/1.jpg" },
  { id: "p2", image_path: "b/2.jpg" },
];

describe("cleanupPublishedImages", () => {
  it("keine pins: cleaned 0, storage nie gerufen", async () => {
    const { client, remove } = fakeClient([]);
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 0, cleaned: 0, failed: 0, dryRun: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it("erfolgspfad: bilder entfernt und pfade genullt", async () => {
    const { client, remove, nullPaths } = fakeClient(twoPins);
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 2, failed: 0, dryRun: false });
    expect(remove).toHaveBeenCalledWith("pin-images", ["a/1.jpg", "b/2.jpg"]);
    expect(nullPaths).toHaveBeenCalledWith(["p1", "p2"]);
  });

  it("storage-fehler: failed, kein db-update", async () => {
    const { client, nullPaths } = fakeClient(twoPins, { removeError: "boom" });
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 2, dryRun: false });
    expect(nullPaths).not.toHaveBeenCalled();
  });

  it("db-update-fehler: failed", async () => {
    const { client } = fakeClient(twoPins, { updateError: "nope" });
    const result = await cleanupPublishedImages(client, { dryRun: false });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 2, dryRun: false });
  });

  it("dryRun: nichts gelöscht, nichts genullt", async () => {
    const { client, remove, nullPaths } = fakeClient(twoPins);
    const result = await cleanupPublishedImages(client, { dryRun: true });
    expect(result).toEqual({ total: 2, cleaned: 0, failed: 0, dryRun: true });
    expect(remove).not.toHaveBeenCalled();
    expect(nullPaths).not.toHaveBeenCalled();
  });
});
