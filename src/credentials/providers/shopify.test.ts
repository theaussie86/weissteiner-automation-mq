import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthUrl, exchangeCode, verifyCallbackHmac } from "./shopify.js";

describe("buildAuthUrl", () => {
  it("builds shop-specific authorize url", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "cid",
        shop: "demo.myshopify.com",
        scopes: ["read_products", "write_orders"],
        redirectUri: "https://mq.example.com/credentials/callback/shopify",
        state: "st123",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://demo.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("read_products,write_orders");
    expect(url.searchParams.get("redirect_uri")).toBe("https://mq.example.com/credentials/callback/shopify");
    expect(url.searchParams.get("state")).toBe("st123");
  });
});

describe("verifyCallbackHmac", () => {
  function sign(params: Record<string, string>, secret: string): string {
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    return createHmac("sha256", secret).update(message).digest("hex");
  }

  it("accepts valid hmac", () => {
    const params = { code: "c", shop: "demo.myshopify.com", state: "st", timestamp: "123" };
    const hmac = sign(params, "csec");
    expect(verifyCallbackHmac({ ...params, hmac }, "csec")).toBe(true);
  });

  it("rejects tampered params", () => {
    const params = { code: "c", shop: "demo.myshopify.com", state: "st", timestamp: "123" };
    const hmac = sign(params, "csec");
    expect(verifyCallbackHmac({ ...params, shop: "evil.myshopify.com", hmac }, "csec")).toBe(false);
  });

  it("rejects missing hmac", () => {
    expect(verifyCallbackHmac({ code: "c" }, "csec")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posts to shop token endpoint and parses access token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ access_token: "shpat_x", scope: "read_products" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await exchangeCode(
      { shop: "demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "c0de" },
      fn,
    );
    expect(result).toEqual({ shop: "demo.myshopify.com", accessToken: "shpat_x" });
    expect(calls[0]!.url).toBe("https://demo.myshopify.com/admin/oauth/access_token");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ client_id: "cid", client_secret: "csec", code: "c0de" });
  });

  it("throws on error response", async () => {
    const fn = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ shop: "demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "bad" }, fn),
    ).rejects.toThrow(/401/);
  });

  it("throws on 200 response without access_token", async () => {
    const fn = (async () => new Response(JSON.stringify({ scope: "x" }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      exchangeCode({ shop: "demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "c" }, fn),
    ).rejects.toThrow(/access_token/);
  });
});

describe("shop domain guard", () => {
  it("rejects non-myshopify domains in buildAuthUrl", () => {
    expect(() =>
      buildAuthUrl({ clientId: "cid", shop: "attacker.com", scopes: ["a"], redirectUri: "https://x", state: "st" }),
    ).toThrow(/shop/i);
  });

  it("rejects malicious shop in exchangeCode before any request", async () => {
    const fn = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    await expect(
      exchangeCode({ shop: "evil.com@demo.myshopify.com", clientId: "cid", clientSecret: "csec", code: "c" }, fn),
    ).rejects.toThrow(/shop/i);
  });
});
