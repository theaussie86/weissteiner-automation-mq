import { describe, expect, it } from "vitest";
import { buildAuthUrl, exchangeCode, refreshAccessToken } from "./google.js";

const client = { clientId: "cid", clientSecret: "csec", redirectUri: "https://mq.example.com/credentials/callback/google" };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("buildAuthUrl", () => {
  it("builds consent url with offline access", () => {
    const url = new URL(buildAuthUrl({ ...client, scopes: ["https://www.googleapis.com/auth/drive"], state: "st123" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(client.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st123");
  });
});

describe("exchangeCode", () => {
  it("parses token response", async () => {
    const { fn, calls } = fakeFetch(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "a b",
    });
    const now = 1_750_000_000_000;
    const result = await exchangeCode({ ...client, code: "c0de" }, fn, now);
    expect(result).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["a", "b"],
      expiresAt: new Date(now + 3600_000),
    });
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(calls[0]!.init.body as string);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("c0de");
  });

  it("throws on error response", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant" });
    await expect(exchangeCode({ ...client, code: "bad" }, fn)).rejects.toThrow(/invalid_grant/);
  });
});

describe("refreshAccessToken", () => {
  it("parses refresh response", async () => {
    const { fn, calls } = fakeFetch(200, { access_token: "at2", expires_in: 3599 });
    const now = 1_750_000_000_000;
    const result = await refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fn, now);
    expect(result).toEqual({ accessToken: "at2", expiresAt: new Date(now + 3599_000) });
    const params = new URLSearchParams(calls[0]!.init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt");
  });

  it("throws on revoked token", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_grant" });
    await expect(refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fn)).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

describe("robustness", () => {
  it("surfaces http status on non-JSON error body", async () => {
    const calls: unknown[] = [];
    const fn = (async () => {
      calls.push(1);
      return new Response("<html>Bad Gateway</html>", { status: 502 });
    }) as unknown as typeof fetch;
    await expect(exchangeCode({ ...client, code: "c" }, fn)).rejects.toThrow(/502/);
  });

  it("throws on 200 response with missing access_token", async () => {
    const { fn } = fakeFetch(200, { refresh_token: "rt", expires_in: 3600 });
    await expect(exchangeCode({ ...client, code: "c" }, fn)).rejects.toThrow(/access_token/);
  });

  it("throws on refresh response with missing expires_in", async () => {
    const { fn } = fakeFetch(200, { access_token: "at" });
    await expect(
      refreshAccessToken({ clientId: "cid", clientSecret: "csec", refreshToken: "rt" }, fn),
    ).rejects.toThrow(/expires_in/);
  });
});
