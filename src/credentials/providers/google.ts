// Google OAuth 2.0 (Web Server Flow). access_type=offline + prompt=consent
// erzwingt ein Refresh-Token auch bei Re-Connect (Spec).
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: Date;
}

export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

async function postToken(body: URLSearchParams, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  // Infra-Fehler (Proxy, Rate-Limit) liefern HTML statt JSON — Status muss sichtbar bleiben.
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!response.ok || json === null) {
    const detail = json?.error ?? text.slice(0, 200);
    throw new Error(`Google token endpoint ${response.status}: ${detail}`);
  }
  return json;
}

function requireTokenFields(json: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const expectNumber = field === "expires_in";
    const value = json[field];
    if (expectNumber ? typeof value !== "number" : typeof value !== "string") {
      throw new Error(`Google token response missing field: ${field}`);
    }
  }
}

export async function exchangeCode(
  opts: { clientId: string; clientSecret: string; redirectUri: string; code: string },
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<GoogleTokens> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
    fetchFn,
  );
  requireTokenFields(json, ["access_token", "refresh_token", "expires_in"]);
  return {
    accessToken: json.access_token as string,
    refreshToken: json.refresh_token as string,
    scopes: typeof json.scope === "string" ? json.scope.split(" ") : [],
    expiresAt: new Date(now + (json.expires_in as number) * 1000),
  };
}

export async function refreshAccessToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchFn: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<{ accessToken: string; expiresAt: Date }> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
    fetchFn,
  );
  requireTokenFields(json, ["access_token", "expires_in"]);
  return {
    accessToken: json.access_token as string,
    expiresAt: new Date(now + (json.expires_in as number) * 1000),
  };
}
