import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import {
  escapeHtml,
  renderErrorMail,
  ResendApiError,
  sendPublishErrorMail,
  type ErrorMailStore,
  type ErrorPin,
  type Mailer,
  type ProjectInfo,
} from "./send-publish-error-mail.js";
import type { PublishEventRow, PublishEventStore } from "./publish-events.js";

const NOW = "2026-10-10T12:00:00.000Z";
const noNow = { now: () => new Date(NOW) };

function basePin(overrides: Partial<ErrorPin> = {}): ErrorPin {
  return {
    id: "pin-1",
    title: "Mein Pin",
    blog_project_id: "proj-1",
    status: "error",
    error_notified_at: null,
    article_title: "Mein Artikel",
    ...overrides,
  };
}

function baseProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: "Reiseblog",
    notification_email: "team@example.com",
    tenant_id: "tenant-1",
    ...overrides,
  };
}

function fakeStore(
  pin: ErrorPin | null,
  opts: { project?: ProjectInfo | null; tenantEmail?: string | null } = {},
) {
  const loadPin = vi.fn(async () => pin);
  const loadProject = vi.fn(async () => opts.project ?? null);
  const resolveTenantEmail = vi.fn(async () => opts.tenantEmail ?? null);
  const markNotified = vi.fn(async () => {});
  const store: ErrorMailStore = { loadPin, loadProject, resolveTenantEmail, markNotified };
  return { store, loadPin, loadProject, resolveTenantEmail, markNotified };
}

function fakeMailer(behaviour: () => Promise<void> = async () => {}): {
  mailer: Mailer;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(behaviour);
  return { mailer: { send }, send };
}

const input = { pinId: "pin-1", errorMessage: "kaputt", from: "Pinfinity <noreply@onlineheldinnen.de>", appUrl: "https://app.example" };

describe("sendPublishErrorMail Skip-Fälle", () => {
  it("Pin fehlt => skipped, kein Versand", async () => {
    const { store } = fakeStore(null);
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ skipped: "pin not found" });
    expect(send).not.toHaveBeenCalled();
  });

  it("status != error => skipped", async () => {
    const { store } = fakeStore(basePin({ status: "published" }));
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ skipped: "status is published" });
    expect(send).not.toHaveBeenCalled();
  });

  it("error_notified_at gesetzt => skipped", async () => {
    const { store } = fakeStore(basePin({ error_notified_at: NOW }));
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ skipped: "already notified" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendPublishErrorMail Empfänger-Auflösung", () => {
  it("nutzt notification_email des Projekts", async () => {
    const { store, resolveTenantEmail } = fakeStore(basePin(), { project: baseProject() });
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ sent: true, recipient: "team@example.com" });
    expect(resolveTenantEmail).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].to).toBe("team@example.com");
  });

  it("fällt auf ältestes Profil des Tenants zurück", async () => {
    const { store, resolveTenantEmail } = fakeStore(basePin(), {
      project: baseProject({ notification_email: null }),
      tenantEmail: "owner@example.com",
    });
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ sent: true, recipient: "owner@example.com" });
    expect(resolveTenantEmail).toHaveBeenCalledWith("tenant-1");
    expect(send.mock.calls[0][0].to).toBe("owner@example.com");
  });

  it("leere notification_email wird ignoriert", async () => {
    const { store, resolveTenantEmail } = fakeStore(basePin(), {
      project: baseProject({ notification_email: "  " }),
      tenantEmail: "owner@example.com",
    });
    const { mailer } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ sent: true, recipient: "owner@example.com" });
    expect(resolveTenantEmail).toHaveBeenCalledWith("tenant-1");
  });

  it("kein Empfänger => Unrecoverable", async () => {
    const { store } = fakeStore(basePin(), { project: baseProject({ notification_email: null }), tenantEmail: null });
    const { mailer, send } = fakeMailer();
    const err = await sendPublishErrorMail(store, mailer, input, noNow).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("sendPublishErrorMail Resend-Fehlerklassifikation", () => {
  const run = (behaviour: () => Promise<void>) => {
    const { store } = fakeStore(basePin(), { project: baseProject() });
    const { mailer, send } = fakeMailer(behaviour);
    return { promise: sendPublishErrorMail(store, mailer, input, noNow), send };
  };

  it("429 => Retry (kein UnrecoverableError)", async () => {
    const { promise } = run(async () => {
      throw new ResendApiError(429, "rate limited");
    });
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ResendApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("503 => Retry", async () => {
    const { promise } = run(async () => {
      throw new ResendApiError(503, "down");
    });
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(ResendApiError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("Netzwerkfehler => Retry (propagiert)", async () => {
    const { promise } = run(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  it("422 => Unrecoverable", async () => {
    const { promise } = run(async () => {
      throw new ResendApiError(422, "invalid from");
    });
    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(err.message).toBe("Resend API error: invalid from");
  });

  it("markiert error_notified_at NICHT, wenn der Versand scheitert", async () => {
    const { store, markNotified } = fakeStore(basePin(), { project: baseProject() });
    const { mailer } = fakeMailer(async () => {
      throw new ResendApiError(500, "boom");
    });
    await sendPublishErrorMail(store, mailer, input, noNow).catch(() => {});
    expect(markNotified).not.toHaveBeenCalled();
  });
});

describe("sendPublishErrorMail Erfolgspfad", () => {
  it("rendert, sendet und setzt error_notified_at", async () => {
    const { store, markNotified } = fakeStore(basePin(), { project: baseProject() });
    const { mailer, send } = fakeMailer();
    const result = await sendPublishErrorMail(store, mailer, input, noNow);
    expect(result).toEqual({ sent: true, recipient: "team@example.com" });
    const msg = send.mock.calls[0][0];
    expect(msg.from).toBe("Pinfinity <noreply@onlineheldinnen.de>");
    expect(msg.subject).toBe("[Pinfinity] Fehler beim Veröffentlichen - Reiseblog");
    expect(msg.text).toContain("kaputt");
    expect(msg.html).toContain("https://app.example");
    expect(markNotified).toHaveBeenCalledWith("pin-1", NOW);
  });

  it("ohne blog_project_id wird kein Projekt geladen und auf Tenant verzichtet", async () => {
    const { store, loadProject } = fakeStore(basePin({ blog_project_id: null }));
    const { mailer } = fakeMailer();
    const err = await sendPublishErrorMail(store, mailer, input, noNow).catch((e) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(loadProject).not.toHaveBeenCalled();
  });
});

function fakeEventStore(behaviour?: () => Promise<void>): {
  store: PublishEventStore;
  insertEvent: ReturnType<typeof vi.fn>;
  rows: PublishEventRow[];
} {
  const rows: PublishEventRow[] = [];
  const insertEvent = vi.fn(async (row: PublishEventRow) => {
    if (behaviour) await behaviour();
    rows.push(row);
  });
  return { store: { insertEvent }, insertEvent, rows };
}

describe("sendPublishErrorMail Ereignis mail_sent", () => {
  it("schreibt mail_sent nach erfolgreichem Versand", async () => {
    const { store } = fakeStore(basePin(), { project: baseProject() });
    const { mailer } = fakeMailer();
    const events = fakeEventStore();
    const result = await sendPublishErrorMail(store, mailer, input, {
      ...noNow,
      events: { store: events.store, jobId: "mail-job-7" },
    });
    expect(result).toEqual({ sent: true, recipient: "team@example.com" });
    expect(events.insertEvent).toHaveBeenCalledTimes(1);
    expect(events.rows[0]).toEqual({
      pin_id: "pin-1",
      blog_project_id: "proj-1",
      event_type: "mail_sent",
      attempt: null,
      max_attempts: null,
      message: null,
      details: { recipient: "team@example.com", job_id: "mail-job-7" },
    });
  });

  it("ohne jobId bleibt job_id aus den Details", async () => {
    const { store } = fakeStore(basePin(), { project: baseProject() });
    const { mailer } = fakeMailer();
    const events = fakeEventStore();
    await sendPublishErrorMail(store, mailer, input, {
      ...noNow,
      events: { store: events.store, jobId: null },
    });
    expect(events.rows[0].details).toEqual({ recipient: "team@example.com" });
  });

  it.each([
    ["Pin fehlt", null, {}],
    ["status != error", basePin({ status: "published" }), {}],
    ["bereits benachrichtigt", basePin({ error_notified_at: NOW }), {}],
  ])("übersprungene Mail (%s) schreibt kein Ereignis", async (_label, pin, opts) => {
    const { store } = fakeStore(pin as ErrorPin | null, opts);
    const { mailer } = fakeMailer();
    const events = fakeEventStore();
    const result = await sendPublishErrorMail(store, mailer, input, {
      ...noNow,
      events: { store: events.store, jobId: "mail-job-7" },
    });
    expect(result).toHaveProperty("skipped");
    expect(events.insertEvent).not.toHaveBeenCalled();
  });

  it("gescheiterter Versand schreibt kein Ereignis", async () => {
    const { store } = fakeStore(basePin(), { project: baseProject() });
    const { mailer } = fakeMailer(async () => {
      throw new ResendApiError(500, "boom");
    });
    const events = fakeEventStore();
    await sendPublishErrorMail(store, mailer, input, {
      ...noNow,
      events: { store: events.store, jobId: "mail-job-7" },
    }).catch(() => {});
    expect(events.insertEvent).not.toHaveBeenCalled();
  });

  it("Schreibfehler des Logs beeinflusst den Versand nicht", async () => {
    const { store, markNotified } = fakeStore(basePin(), { project: baseProject() });
    const { mailer, send } = fakeMailer();
    const events = fakeEventStore(async () => {
      throw new Error("pin_publish_events down");
    });
    const result = await sendPublishErrorMail(store, mailer, input, {
      ...noNow,
      events: { store: events.store, jobId: "mail-job-7" },
      log: () => {},
    });
    expect(result).toEqual({ sent: true, recipient: "team@example.com" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledWith("pin-1", NOW);
  });
});

describe("renderErrorMail", () => {
  it("Betreff nutzt den Projektnamen", () => {
    const mail = renderErrorMail({ projectName: "Reiseblog", pinTitle: "P", articleTitle: null, errorMessage: "x", appUrl: "https://a" });
    expect(mail.subject).toBe("[Pinfinity] Fehler beim Veröffentlichen - Reiseblog");
  });

  it("Fallback-Projektname und Pin-Label", () => {
    const mail = renderErrorMail({ projectName: null, pinTitle: null, articleTitle: null, errorMessage: "x", appUrl: "https://a" });
    expect(mail.subject).toBe("[Pinfinity] Fehler beim Veröffentlichen - Unbekanntes Projekt");
    expect(mail.text).toContain("Pin: (ohne Titel)");
  });

  it("fällt auf den Artikel-Titel zurück, wenn der Pin-Titel fehlt", () => {
    const mail = renderErrorMail({ projectName: "P", pinTitle: null, articleTitle: "Artikel", errorMessage: "x", appUrl: "https://a" });
    expect(mail.text).toContain("Pin: Artikel");
  });

  it("escaped die Fehlermeldung im HTML, nicht im Text", () => {
    const mail = renderErrorMail({
      projectName: "P",
      pinTitle: "T",
      articleTitle: null,
      errorMessage: '<script>alert("x")</script>',
      appUrl: "https://a",
    });
    expect(mail.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(mail.html).not.toContain("<script>alert");
    expect(mail.text).toContain('<script>alert("x")</script>');
  });

  it("behält echte Umlaute", () => {
    const mail = renderErrorMail({ projectName: "Café", pinTitle: "Grüße", articleTitle: null, errorMessage: "fehlgeschlagen", appUrl: "https://a" });
    expect(mail.subject).toContain("Veröffentlichen");
    expect(mail.subject).toContain("Café");
    expect(mail.html).toContain("Grüße");
  });
});

describe("escapeHtml", () => {
  it("escaped die Sonderzeichen", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});
