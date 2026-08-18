import { spawnSync } from "node:child_process";

const DOPPLER_PROJECT = "listen-cx";
const DOPPLER_CONFIG = "stg";
const WRANGLER_ENV = "staging";
const SECRET_NAMES = [
  "APPLE_MUSIC_TEAM_ID",
  "APPLE_MUSIC_KEY_ID",
  "APPLE_MUSIC_PRIVATE_KEY_P8",
  "APPLE_MUSIC_MEDIA_ID",
  "APPLE_MUSIC_ALLOWED_ORIGINS",
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}${details ? `: ${details}` : ""}`);
  }
  return result.stdout ?? "";
}

function readDopplerSecret(name) {
  const value = run("doppler", [
    "secrets",
    "get",
    name,
    "--project",
    DOPPLER_PROJECT,
    "--config",
    DOPPLER_CONFIG,
    "--plain",
    "--raw",
    "--silent",
  ]).replace(/\r?\n$/, "");
  if (!value) throw new Error(`Doppler returned an empty value for ${name}`);
  return value;
}

for (const name of SECRET_NAMES) {
  const value = readDopplerSecret(name);
  run("pnpm", ["exec", "wrangler", "secret", "put", name, "--env", WRANGLER_ENV], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`Synced ${name} to the staging Worker.`);
}

console.log("Apple Music staging secrets synced without writing a local secret file.");
