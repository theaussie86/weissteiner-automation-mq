// Macht aus der technischen Fehlermeldung eine Meldung mit Handlungsanweisung für die
// Pinfinity-UI (pins.error_message) und die Fehler-Mail. Die Roh-Meldung bleibt vorn
// stehen, die Anweisung folgt nach " - Was tun: ". pin_publish_events behalten die
// Roh-Meldung.

interface HintRule {
  test: (message: string, httpStatus: number | null) => boolean;
  hint: string;
}

const RULES: HintRule[] = [
  {
    test: (m) => m.includes("No Pinterest account connected"),
    hint: "Pinterest-Konto in den Projekteinstellungen verbinden, danach den Pin neu planen.",
  },
  {
    test: (m) => m.includes("Failed to retrieve Pinterest access token") || m.includes("Pinterest connection"),
    hint: "Pinterest-Konto in den Projekteinstellungen neu verbinden, danach den Pin neu planen.",
  },
  {
    test: (m) => m.includes("Pin must have a Pinterest board"),
    hint: "Im Pin ein Pinterest-Board auswählen und den Pin neu planen.",
  },
  {
    test: (m) => m.includes("Pin must have a video"),
    hint: "Im Pin ein Video hochladen und den Pin neu planen.",
  },
  {
    test: (m) => m.includes("Pin must have an image"),
    hint: "Im Pin ein Bild hochladen und den Pin neu planen.",
  },
  {
    test: (m) => m.includes("media processing failed"),
    hint: "Video prüfen (MP4, H.264) und neu hochladen, danach den Pin neu planen.",
  },
  {
    test: (m) => m.includes("media processing timed out"),
    hint: "Pin neu planen. Tritt es wieder auf, ein kleineres oder kürzeres Video hochladen.",
  },
  {
    test: (m) => m.includes("DB-Update fehlgeschlagen"),
    hint: "Pin nicht neu planen, er liegt schon auf Pinterest. Pinfinity-Betreuung informieren.",
  },
  {
    test: (_m, s) => s === 401 || s === 403,
    hint: "Pinterest-Konto in den Projekteinstellungen neu verbinden, danach den Pin neu planen.",
  },
  {
    test: (_m, s) => s === 429,
    hint: "Pinterest-Limit erreicht. Pin später neu planen.",
  },
  {
    test: (_m, s) => s != null && s >= 500,
    hint: "Pinterest hatte eine Störung. Pin später neu planen.",
  },
  {
    test: (m, s) => s === 400 || s === 404 || m.includes("Pinterest API error"),
    hint: "Pin-Daten prüfen (Board, Bild/Video, Titel, Link) und den Pin neu planen.",
  },
  {
    test: (m) => m.includes("column ") && m.includes("does not exist"),
    hint: "Technischer Fehler im Veröffentlichungsdienst. Pinfinity-Betreuung informieren, danach den Pin neu planen.",
  },
];

const FALLBACK_HINT =
  "Pin-Daten prüfen und den Pin neu planen. Tritt der Fehler wieder auf, Pinfinity-Betreuung informieren.";

const SEPARATOR = " - Was tun: ";

export function withActionHint(message: string, httpStatus: number | null = null): string {
  if (message.includes(SEPARATOR)) return message;
  const rule = RULES.find((r) => r.test(message, httpStatus));
  return `${message}${SEPARATOR}${rule?.hint ?? FALLBACK_HINT}`;
}
