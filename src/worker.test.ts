import { expect, it } from "vitest";
import { getWorkerBaseUrl, jamsAreEnabled } from "./worker.js";

it("uses local origins for development and the configured origin otherwise", () => {
  expect(getWorkerBaseUrl({ BASE_URL: "https://listen.cx" }, "http://localhost:8787/")).toBe("http://localhost:8787");
  expect(getWorkerBaseUrl({ BASE_URL: "https://listen.cx/" }, "https://other.example/")).toBe("https://listen.cx");
  expect(getWorkerBaseUrl({ BASE_URL: "" }, "https://dev.example/")).toBe("https://dev.example");
});

it("enables Jams only for an explicit local setting", () => {
  expect(jamsAreEnabled("true", "http://127.0.0.1:8787/mcp")).toBe(true);
  expect(jamsAreEnabled("true", "http://localhost:8787/mcp")).toBe(true);
  expect(jamsAreEnabled("true", "http://[::1]:8787/mcp")).toBe(true);
  expect(jamsAreEnabled("false", "http://127.0.0.1:8787/mcp")).toBe(false);
  expect(jamsAreEnabled(undefined, "http://127.0.0.1:8787/mcp")).toBe(false);
  expect(jamsAreEnabled("true", "https://staging.listen.cx/mcp")).toBe(false);
  expect(jamsAreEnabled("true", "https://listen.cx/mcp")).toBe(false);
});
