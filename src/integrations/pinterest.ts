// Schlanker Pinterest-v5-Client (Ticket #10). Nur was die Publish-Jobs brauchen:
// einen Bild-Pin anlegen. Fehler werden als PinterestApiError mit HTTP-Status
// geworfen, damit die Job-Orchestrierung sie klassifizieren kann (429/5xx = Retry,
// 401 = Connection inaktiv, übrige 4xx = Unrecoverable). Netzwerk-/Timeout-Fehler
// propagiert der zugrunde liegende fetch als eigenen Error (ebenfalls Retry).

const API_BASE = "https://api.pinterest.com/v5";

// Fehler mit HTTP-Status. message wie in der Edge Function: "Pinterest API error: <message>".
export class PinterestApiError extends Error {
  readonly status: number;
  constructor(status: number, apiMessage: string) {
    super(`Pinterest API error: ${apiMessage}`);
    this.name = "PinterestApiError";
    this.status = status;
  }
}

export type PinterestMediaSource = { source_type: "image_url"; url: string };

export interface PinterestCreatePinPayload {
  board_id: string;
  media_source: PinterestMediaSource;
  title?: string;
  description?: string;
  alt_text?: string;
  link?: string;
  /** Wird komplett weggelassen, wenn keine Kennzeichnung greift (siehe buildAiDisclosures). */
  ai_disclosures?: { values: string[] };
}

// Schmaler Seam: die Orchestrierung testet gegen diese eine Methode, der echte
// fetch-Adapter liegt darunter.
export interface PinterestClient {
  createPin(accessToken: string, payload: PinterestCreatePinPayload): Promise<{ id: string }>;
}

export function createPinterestClient(fetchImpl: typeof fetch = fetch): PinterestClient {
  return {
    async createPin(accessToken, payload) {
      const response = await fetchImpl(`${API_BASE}/pins`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let apiMessage = `${response.status} ${response.statusText}`;
        try {
          const json = JSON.parse(text);
          if (json?.message) apiMessage = json.message as string;
        } catch {
          // Kein JSON-Body: Status/Statustext als Meldung behalten.
        }
        throw new PinterestApiError(response.status, apiMessage);
      }
      const json = (await response.json()) as { id: string };
      return { id: json.id };
    },
  };
}
