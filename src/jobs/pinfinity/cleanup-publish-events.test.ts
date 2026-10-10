import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  cleanupPublishEvents,
  DEFAULT_RETENTION_DAYS,
  type PublishEventsCleanupClient,
} from "./cleanup-publish-events.js";

// now fest auf 2026-01-01T00:00:00Z, damit der Cutoff deterministisch ist.
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

function fakeClient(opts: {
  batches?: number[];
  count?: number;
  deleteError?: string;
}): {
  client: PublishEventsCleanupClient;
  del: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
} {
  const queue = [...(opts.batches ?? [])];
  const del = vi.fn(async () => {
    if (opts.deleteError) throw new Error(opts.deleteError);
    return queue.length > 0 ? queue.shift()! : 0;
  });
  const count = vi.fn(async () => opts.count ?? 0);
  const client: PublishEventsCleanupClient = {
    countOlderThan: count,
    deleteBatchOlderThan: del,
  };
  return { client, del, count };
}

describe("cleanupPublishEvents", () => {
  it("löscht in Batches bis eine Teilmenge kleiner als BATCH_SIZE zurückkommt", async () => {
    const { client, del } = fakeClient({ batches: [BATCH_SIZE, BATCH_SIZE, 7] });
    const result = await cleanupPublishEvents(client, {
      retentionDays: DEFAULT_RETENTION_DAYS,
      dryRun: false,
      now: () => NOW,
    });
    expect(result).toEqual({ deleted: 2 * BATCH_SIZE + 7, dryRun: false });
    expect(del).toHaveBeenCalledTimes(3);
  });

  it("leerer Bestand: ein Batch, deleted 0", async () => {
    const { client, del } = fakeClient({ batches: [0] });
    const result = await cleanupPublishEvents(client, {
      retentionDays: DEFAULT_RETENTION_DAYS,
      dryRun: false,
      now: () => NOW,
    });
    expect(result).toEqual({ deleted: 0, dryRun: false });
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("dryRun: zählt nur, löscht nichts", async () => {
    const { client, del, count } = fakeClient({ count: 42 });
    const result = await cleanupPublishEvents(client, {
      retentionDays: DEFAULT_RETENTION_DAYS,
      dryRun: true,
      now: () => NOW,
    });
    expect(result).toEqual({ deleted: 42, dryRun: true });
    expect(count).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
  });

  it("berechnet den Cutoff aus retentionDays", async () => {
    const { client, del } = fakeClient({ batches: [0] });
    await cleanupPublishEvents(client, { retentionDays: 90, dryRun: false, now: () => NOW });
    const expectedCutoff = new Date(NOW - 90 * 24 * 3600 * 1000).toISOString();
    expect(del).toHaveBeenCalledWith(expectedCutoff, BATCH_SIZE);
  });

  it("Fehler in einem Batch bricht ab und propagiert (Retry über Standard-Policy)", async () => {
    const { client } = fakeClient({ deleteError: "db weg" });
    await expect(
      cleanupPublishEvents(client, { retentionDays: DEFAULT_RETENTION_DAYS, dryRun: false, now: () => NOW }),
    ).rejects.toThrow("db weg");
  });
});
