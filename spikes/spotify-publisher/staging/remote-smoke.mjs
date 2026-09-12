import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const origin = "https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev";
const browserOrigin = "https://staging.listen.cx";
const secrets = JSON.parse(await readFile(join(homedir(), ".local/state/songlink/spotify-publisher-staging/secrets.json"), "utf8"));
const operator = { Authorization: `Bearer ${secrets.OPERATOR_TOKEN}`, "Content-Type": "application/json" };
const results = [];
async function check(name, path, expected, options = {}, requestOrigin = path.startsWith("/auth/") ? browserOrigin : origin) {
  const response = await fetch(requestOrigin + path, { redirect: "manual", signal: AbortSignal.timeout(15000), ...options });
  assert.equal(response.status, expected, name);
  const body = await response.text();
  for (const secret of [secrets.OPERATOR_TOKEN, secrets.TOKEN_ENCRYPTION_KEY]) assert.ok(!body.includes(secret), `${name}: no secret disclosure`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), response.headers.get("content-type")?.startsWith("text/html") ? "same-origin" : "no-referrer");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  results.push({ name, status: response.status });
  return { response, body };
}

await check("health", "/health", 200);
await check("private status", "/control/status", 401);
await check("private readback", "/control/readback?playlistKey=unconfigured-probe", 401);
await check("private token transport", "/control/token-transport", 401);
await check("unauthorized write", "/control/desired", 401, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
await check("cross-origin control", "/control/invitations", 403, { method: "POST", headers: { ...operator, Origin: "https://attacker.example" } });
await check("invalid callback", "/auth/callback?state=guessed&code=invalid", 400);
await check("invalid invitation", "/auth/invite?ticket=guessed", 400);
await check("browser endpoint rejects operator host", "/auth/callback?state=guessed", 400, {}, origin);
for (const path of ["/auth/invite-unrelated", "/auth/start-unrelated", "/auth/callback-unrelated"]) await check("exact route match " + path, path, 404);
const status = await check("operator status", "/control/status", 200, { headers: operator });
const state = JSON.parse(status.body);

if (process.argv.includes("--exercise-invitation")) {
  const invitation = await check("create expendable invitation", "/control/invitations", 201, { method: "POST", headers: operator });
  const invite = new URL(JSON.parse(invitation.body).inviteUrl);
  assert.equal(invite.origin, browserOrigin);
  await check("preview preserves invitation", invite.pathname + invite.search, 200);
  const landing = await check("repeated GET preserves invitation", invite.pathname + invite.search, 200);
  const csrf = landing.body.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const inviteCookie = landing.response.headers.get("set-cookie").split(";")[0];
  const form = new URLSearchParams({ ticket: invite.searchParams.get("ticket"), csrf }).toString();
  const postOptions = { method: "POST", headers: { Origin: browserOrigin, Cookie: inviteCookie, "Content-Type": "application/x-www-form-urlencoded" }, body: form };
  await check("malicious POST preserves invitation", "/auth/start", 403, { ...postOptions, headers: { ...postOptions.headers, Origin: "https://attacker.example" } });
  const start = await check("browser-bound consent redirect", "/auth/start", 302, postOptions);
  assert.match(start.response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  const authorization = new URL(start.response.headers.get("location"));
  assert.equal(authorization.origin, "https://accounts.spotify.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), browserOrigin + "/auth/callback");
  await check("invitation POST replay denied", "/auth/start", 400, postOptions);
  const browser = start.response.headers.get("set-cookie").split(";")[0];
  const query = new URLSearchParams({ state: authorization.searchParams.get("state"), error: "access_denied" });
  await check("callback requires browser", "/auth/callback?" + query, 400);
  await check("denied consent consumed safely", "/auth/callback?" + query, 400, { headers: { Cookie: browser } });
  await check("callback replay denied", "/auth/callback?" + query, 400, { headers: { Cookie: browser } });
}
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin, browserOrigin, configuredCallback: browserOrigin + "/auth/callback", publisherAuthorized: state.authorized, providerWritesPerformed: false, checks: results }, null, 2));
