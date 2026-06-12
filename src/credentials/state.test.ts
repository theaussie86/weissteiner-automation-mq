import { describe, expect, it } from "vitest";
import { consumeState, createState, type StatePayload } from "./state.js";

// Fake-Redis: nur die zwei genutzten Befehle (set mit EX, getdel).
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    set: async (key: string, value: string, _ex: string, _ttl: number) => {
      store.set(key, value);
      return "OK";
    },
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
  };
}

const payload: StatePayload = { name: "google-wachmacherei", provider: "google", scopes: ["a"] };

describe("oauth state", () => {
  it("roundtrips payload and is single-use", async () => {
    const redis = fakeRedis();
    const state = await createState(redis, payload);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(await consumeState(redis, state)).toEqual(payload);
    expect(await consumeState(redis, state)).toBeNull();
  });

  it("returns null for unknown state", async () => {
    expect(await consumeState(fakeRedis(), "deadbeef")).toBeNull();
  });
});
