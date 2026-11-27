import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { getJobType } from "../registry.js";
import { postSlackMessage, SlackWebhookError, type SlackPoster } from "./post-message.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/xyz";
const cred = { webhookUrl: WEBHOOK };

function fakePoster(behaviour: () => Promise<void> = async () => {}) {
  const post = vi.fn(behaviour);
  const poster: SlackPoster = { post };
  return { poster, post };
}

describe("postSlackMessage", () => {
  it("schickt den Text an die Webhook-URL aus dem Credential", async () => {
    const { poster, post } = fakePoster();
    await expect(postSlackMessage(poster, cred, "Backup fehlgeschlagen")).resolves.toEqual({ posted: true });
    expect(post).toHaveBeenCalledWith(WEBHOOK, "Backup fehlgeschlagen");
  });

  it("lehnt ein Credential ohne webhookUrl als nicht wiederholbar ab", async () => {
    const { poster, post } = fakePoster();
    await expect(postSlackMessage(poster, {}, "x")).rejects.toBeInstanceOf(UnrecoverableError);
    expect(post).not.toHaveBeenCalled();
  });

  it("lehnt eine Webhook-URL außerhalb von hooks.slack.com ab", async () => {
    const { poster, post } = fakePoster();
    await expect(postSlackMessage(poster, { webhookUrl: "https://evil.example/hook" }, "x")).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("nennt die Webhook-URL nicht in der Fehlermeldung", async () => {
    const { poster } = fakePoster();
    const err = await postSlackMessage(poster, { webhookUrl: "https://evil.example/secret" }, "x").catch((e) => e);
    expect((err as Error).message).not.toContain("secret");
  });

  it.each([429, 500, 503])("wiederholt bei HTTP %i (transient)", async (status) => {
    const { poster } = fakePoster(async () => {
      throw new SlackWebhookError(status, "busy");
    });
    const err = await postSlackMessage(poster, cred, "x").catch((e) => e);
    expect(err).toBeInstanceOf(SlackWebhookError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it.each([400, 403, 404, 410])("gibt bei HTTP %i auf (nicht wiederholbar)", async (status) => {
    const { poster } = fakePoster(async () => {
      throw new SlackWebhookError(status, "no_service");
    });
    await expect(postSlackMessage(poster, cred, "x")).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("wiederholt bei Netzwerkfehlern", async () => {
    const { poster } = fakePoster(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await postSlackMessage(poster, cred, "x").catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
  });
});

describe("Job-Typ slack.post-message", () => {
  const jobType = getJobType("slack.post-message")!;

  it("ist in der Queue integrations registriert, mit Retries", () => {
    expect(jobType.queue).toBe("integrations");
    expect(jobType.attempts).toBeGreaterThan(1);
  });

  it("verlangt Credential-Name und nicht-leeren Text", () => {
    expect(jobType.payloadSchema.safeParse({ slackCredential: "slack-homelab", text: "hi" }).success).toBe(true);
    expect(jobType.payloadSchema.safeParse({ slackCredential: "slack-homelab", text: "" }).success).toBe(false);
    expect(jobType.payloadSchema.safeParse({ text: "hi" }).success).toBe(false);
  });

  it("begrenzt den Text", () => {
    expect(jobType.payloadSchema.safeParse({ slackCredential: "s", text: "a".repeat(4001) }).success).toBe(false);
  });
});
