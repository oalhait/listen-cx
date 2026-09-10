import { expect, it } from "vitest";
import { getWorkerBaseUrl } from "./worker.js";

it("uses local origins for development and the configured origin otherwise", () => {
  expect(getWorkerBaseUrl({ BASE_URL: "https://listen.cx" }, "http://localhost:8787/")).toBe("http://localhost:8787");
  expect(getWorkerBaseUrl({ BASE_URL: "https://listen.cx/" }, "https://other.example/")).toBe("https://listen.cx");
  expect(getWorkerBaseUrl({ BASE_URL: "" }, "https://dev.example/")).toBe("https://dev.example");
});
