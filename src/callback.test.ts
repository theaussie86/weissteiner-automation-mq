import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendCallback, signCallbackBody } from "./callback.js";

let received: { body: string; signature: string | undefined }[] = [];
let failFirst = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (failFirst > 0) {
      failFirst--;
      res.writeHead(500).end();
      return;
    }
    received.push({ body, signature: req.headers["x-mq-signature"] as string | undefined });
    res.writeHead(200).end("ok");
  });
});

beforeAll(() => new Promise<void>((r) => server.listen(5099, () => r())));
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const payload = {
  jobId: "1",
  queue: "integrations",
  type: "integrations.ping",
  status: "completed" as const,
  tenant: "wachmacherei",
  result: { echo: "hi" },
};

describe("sendCallback", () => {
  it("posts signed payload", async () => {
    received = [];
    const res = await sendCallback("http://localhost:5099/hook", payload, "secret-0123456789abc");
    expect(res.ok).toBe(true);
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(JSON.parse(r.body)).toMatchObject({ jobId: "1", status: "completed", tenant: "wachmacherei" });
    expect(r.signature).toBe(signCallbackBody("secret-0123456789abc", r.body));
  });

  it("retries on 500 and succeeds", async () => {
    received = [];
    failFirst = 1;
    const res = await sendCallback("http://localhost:5099/hook", payload);
    expect(res.ok).toBe(true);
    expect(received).toHaveLength(1);
  }, 15_000);

  it("reports failure for unreachable host", async () => {
    const res = await sendCallback("http://localhost:9/nope", payload);
    expect(res.ok).toBe(false);
  }, 20_000);
});
