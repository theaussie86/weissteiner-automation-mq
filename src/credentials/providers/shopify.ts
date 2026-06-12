import { createHmac, timingSafeEqual } from "node:crypto";

// Shopify OAuth (Authorization Code Grant). Tokens laufen nicht ab — kein Refresh.
// Callback-Parameter sind per HMAC-SHA256 mit dem Client-Secret signiert.

export function buildAuthUrl(opts: {
  clientId: string;
  shop: string;
  scopes: string[];
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://${opts.shop}/admin/oauth/authorize`);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("scope", opts.scopes.join(","));
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export function verifyCallbackHmac(query: Record<string, string | undefined>, clientSecret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .filter((k) => rest[k] !== undefined)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const expected = createHmac("sha256", clientSecret).update(message).digest("hex");
  if (expected.length !== hmac.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(hmac, "utf8"));
}

export async function exchangeCode(
  opts: { shop: string; clientId: string; clientSecret: string; code: string },
  fetchFn: typeof fetch = fetch,
): Promise<{ shop: string; accessToken: string }> {
  const response = await fetchFn(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, code: opts.code }),
  });
  if (!response.ok) {
    throw new Error(`Shopify token endpoint ${response.status}`);
  }
  // Auch bei 200 gegen kaputte Antworten absichern — kein undefined in den Store.
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof json.access_token !== "string") {
    throw new Error("Shopify token response missing field: access_token");
  }
  return { shop: opts.shop, accessToken: json.access_token };
}
