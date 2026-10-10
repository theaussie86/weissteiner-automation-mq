// Schlanker Pinterest-v5-Client (Ticket #10/#11). Was die Publish-Jobs brauchen:
// einen Bild-Pin anlegen sowie den mehrstufigen Video-Ablauf (Media registrieren,
// nach S3 hochladen, Verarbeitung pollen, Video-Pin anlegen). Fehler werden als
// PinterestApiError mit HTTP-Status geworfen, damit die Job-Orchestrierung sie
// klassifizieren kann (429/5xx = Retry, 401 = Connection inaktiv, übrige 4xx =
// Unrecoverable). Netzwerk-/Timeout-Fehler propagiert der zugrunde liegende fetch
// als eigenen Error (ebenfalls Retry).

import { openAsBlob } from "node:fs";

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

export type PinterestMediaSource =
  | { source_type: "image_url"; url: string }
  | {
      source_type: "video_id";
      media_id: string;
      cover_image_url?: string;
      /** Zeitpunkt im Video (Millisekunden), der als Cover dient. */
      cover_image_key_frame_time?: number;
    };

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

// Antwort von POST /v5/media: einmalig verwendbare media_id plus signierte S3-Upload-Daten.
export interface PinterestVideoRegistration {
  mediaId: string;
  uploadUrl: string;
  uploadParameters: Record<string, string>;
}

// Status aus GET /v5/media/{id}. succeeded => fertig, failed => Unrecoverable.
export type PinterestMediaStatus = "registered" | "processing" | "succeeded" | "failed";

// Schmaler Seam: die Orchestrierung testet gegen diese Methoden, der echte
// fetch-Adapter liegt darunter.
export interface PinterestClient {
  createPin(accessToken: string, payload: PinterestCreatePinPayload): Promise<{ id: string }>;
  /** POST /v5/media { media_type: "video" }: registriert ein Video (einmalige media_id). */
  registerVideoMedia(accessToken: string): Promise<PinterestVideoRegistration>;
  /**
   * Lädt die Datei per multipart/form-data nach Pinterests S3. Reihenfolge: erst alle
   * upload_parameters, zuletzt das Feld `file`. Die Datei wird vom Pfad gestreamt, nicht
   * komplett in den RAM geladen.
   */
  uploadVideoToS3(registration: PinterestVideoRegistration, filePath: string): Promise<void>;
  /** GET /v5/media/{id}: aktueller Verarbeitungsstatus. */
  getMediaStatus(accessToken: string, mediaId: string): Promise<PinterestMediaStatus>;
}

// Baut aus einer fehlgeschlagenen Antwort den PinterestApiError (message aus JSON-Body,
// sonst Status/Statustext). Gemeinsam für alle Pinterest-Calls.
async function toPinterestApiError(response: Response): Promise<PinterestApiError> {
  const text = await response.text().catch(() => "");
  let apiMessage = `${response.status} ${response.statusText}`;
  try {
    const json = JSON.parse(text);
    if (json?.message) apiMessage = json.message as string;
  } catch {
    // Kein JSON-Body: Status/Statustext als Meldung behalten.
  }
  return new PinterestApiError(response.status, apiMessage);
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
      if (!response.ok) throw await toPinterestApiError(response);
      const json = (await response.json()) as { id: string };
      return { id: json.id };
    },
    async registerVideoMedia(accessToken) {
      const response = await fetchImpl(`${API_BASE}/media`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ media_type: "video" }),
      });
      if (!response.ok) throw await toPinterestApiError(response);
      const json = (await response.json()) as {
        media_id: string;
        upload_url: string;
        upload_parameters: Record<string, string>;
      };
      return { mediaId: json.media_id, uploadUrl: json.upload_url, uploadParameters: json.upload_parameters };
    },
    async uploadVideoToS3(registration, filePath) {
      const form = new FormData();
      // Reihenfolge ist für S3 signifikant: erst alle Parameter, dann die Datei.
      for (const [key, value] of Object.entries(registration.uploadParameters)) {
        form.append(key, value);
      }
      // openAsBlob streamt vom Dateisystem (kein Komplett-Buffer im RAM).
      const blob = await openAsBlob(filePath);
      form.append("file", blob);
      const response = await fetchImpl(registration.uploadUrl, { method: "POST", body: form });
      // S3 antwortet mit 204 bei Erfolg. Fehler als PinterestApiError (5xx Retry, 4xx Unrecoverable).
      if (!response.ok) throw await toPinterestApiError(response);
    },
    async getMediaStatus(accessToken, mediaId) {
      const response = await fetchImpl(`${API_BASE}/media/${mediaId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw await toPinterestApiError(response);
      const json = (await response.json()) as { status: PinterestMediaStatus };
      return json.status;
    },
  };
}
