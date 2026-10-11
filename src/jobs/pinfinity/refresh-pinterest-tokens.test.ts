import { describe, expect, it, vi } from "vitest";
import { PinterestApiError } from "../../integrations/pinterest.js";
import { refreshPinterestTokens, type RefreshClient, type TokenRefresher } from "./refresh-pinterest-tokens.js";

const expiresAt = new Date("2026-12-01T00:00:00Z");
const okTokens = { accessToken: "new-a", refreshToken: "new-r", expiresAt };

function fakeClient(ids: string[], over: Partial<RefreshClient> = {}) {
  const client = {
    listExpiringConnections: vi.fn(async () => ids.map((id) => ({ id }))),
    getRefreshToken: vi.fn(async (id: string) => `rt-${id}`),
    storeTokens: vi.fn(async () => ({ error: null })),
    markRefreshed: vi.fn(async () => ({ error: null })),
    deactivate: vi.fn(async () => ({ error: null })),
    recordError: vi.fn(async () => ({ error: null })),
    ...over,
  };
  return client satisfies RefreshClient;
}

describe("refreshPinterestTokens", () => {
  it("keine Connections: nichts zu tun", async () => {
    const client = fakeClient([]);
    const refresher = vi.fn();
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result).toEqual({ total: 0, refreshed: 0, failed: 0, dryRun: false, details: [] });
    expect(refresher).not.toHaveBeenCalled();
  });

  it("dryRun: zählt, ruft Pinterest nie", async () => {
    const client = fakeClient(["c1", "c2"]);
    const refresher = vi.fn();
    const result = await refreshPinterestTokens(client, refresher, { dryRun: true });
    expect(result).toMatchObject({ total: 2, refreshed: 0, dryRun: true });
    expect(refresher).not.toHaveBeenCalled();
    expect(client.storeTokens).not.toHaveBeenCalled();
  });

  it("Erfolgspfad: Tokens gespeichert, Ablauf aktualisiert", async () => {
    const client = fakeClient(["c1"]);
    const refresher: TokenRefresher = vi.fn(async () => okTokens);
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result).toMatchObject({ total: 1, refreshed: 1, failed: 0 });
    expect(refresher).toHaveBeenCalledWith("rt-c1");
    expect(client.storeTokens).toHaveBeenCalledWith("c1", "new-a", "new-r");
    expect(client.markRefreshed).toHaveBeenCalledWith("c1", expiresAt);
  });

  it("4xx von Pinterest: Connection deaktiviert, übrige laufen weiter", async () => {
    const client = fakeClient(["c1", "c2"]);
    const refresher: TokenRefresher = vi
      .fn()
      .mockRejectedValueOnce(new PinterestApiError(400, "invalid_grant"))
      .mockResolvedValueOnce(okTokens);
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result).toMatchObject({ refreshed: 1, failed: 1 });
    expect(client.deactivate).toHaveBeenCalledWith("c1", "Token refresh failed: Pinterest API error: invalid_grant");
    expect(client.recordError).not.toHaveBeenCalled();
  });

  it.each([[500], [429]])("%i von Pinterest: transient, Connection bleibt aktiv", async (status) => {
    const client = fakeClient(["c1"]);
    const refresher: TokenRefresher = vi.fn(async () => {
      throw new PinterestApiError(status, "later");
    });
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result.failed).toBe(1);
    expect(client.recordError).toHaveBeenCalledTimes(1);
    expect(client.deactivate).not.toHaveBeenCalled();
  });

  it("Netzwerkfehler: transient", async () => {
    const client = fakeClient(["c1"]);
    const refresher: TokenRefresher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(client.recordError).toHaveBeenCalledTimes(1);
    expect(client.deactivate).not.toHaveBeenCalled();
  });

  it("Vault-RPC-Fehler: transient, kein Pinterest-Call", async () => {
    const client = fakeClient(["c1"], {
      getRefreshToken: vi.fn(async () => {
        throw new Error("Failed to retrieve refresh token: boom");
      }),
    });
    const refresher = vi.fn();
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result.failed).toBe(1);
    expect(refresher).not.toHaveBeenCalled();
    expect(client.recordError).toHaveBeenCalledTimes(1);
  });

  it("Speichern im Vault scheitert: als Fehler gezählt, Ablauf nicht aktualisiert", async () => {
    const client = fakeClient(["c1"], { storeTokens: vi.fn(async () => ({ error: "rls" })) });
    const result = await refreshPinterestTokens(client, async () => okTokens, { dryRun: false });
    expect(result.details[0]).toMatchObject({ success: false, error: "Failed to store new tokens: rls" });
    expect(client.markRefreshed).not.toHaveBeenCalled();
  });

  it("Fehler beim Fehler-Schreiben blockiert die nächste Connection nicht", async () => {
    const client = fakeClient(["c1", "c2"], {
      recordError: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const refresher: TokenRefresher = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce(okTokens);
    const result = await refreshPinterestTokens(client, refresher, { dryRun: false });
    expect(result).toMatchObject({ refreshed: 1, failed: 1 });
  });
});
