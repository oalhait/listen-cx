import { expect, it } from "vitest";
import { isRecord, readBoundedJson } from "./request.js";

it("reads JSON within the byte limit", async () => {
  expect(await readBoundedJson(new Request("https://listen.test", { method: "POST", body: JSON.stringify({ title: "Road trip" }) }))).toEqual({ ok: true, value: { title: "Road trip" } });
});
it("rejects malformed JSON and streaming bodies that exceed the byte limit", async () => {
  expect(await readBoundedJson(new Request("https://listen.test", { method: "POST", body: "{" }))).toMatchObject({ ok: false, status: 400 });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('"' + 'x'.repeat(4096))); controller.close(); } });
  expect(await readBoundedJson(new Request("https://listen.test", { method: "POST", body: stream }))).toMatchObject({ ok: false, status: 413 });
});
it("accepts only non-array objects as records", () => {
  expect(isRecord({ title: "Road trip" })).toBe(true);
  for (const value of [null, [], "text", 1]) expect(isRecord(value)).toBe(false);
});
