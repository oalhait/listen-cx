import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateDesired, type Observation } from "../../src/publishing/spotify/publisher.ts";

export type Manifest = { playlistKey: string; publisherId: string; appMode: "development" | "extended-quota"; trackIds: [string, string, string, string] };
type Phase = "initial" | "updated";
type RequestControl = (path: string, method?: string, body?: unknown) => Promise<unknown>;
export type Receipt = { schemaVersion: 1; manifest: Manifest; phase: Phase; verified: boolean; observation: Observation; listenerVerification: "pending" };
const origin = "https://listen-cx-spotify-spike-staging.omar-alhait.workers.dev";
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export async function runPhase(options: { manifest: Manifest; phase: Phase; publish?: boolean; initial?: Receipt; request: RequestControl }): Promise<Receipt> {
  const { manifest, phase, request, initial } = options;
  if (!manifest || typeof manifest.publisherId !== "string" || !manifest.publisherId || !["development", "extended-quota"].includes(manifest.appMode)
    || !Array.isArray(manifest.trackIds) || manifest.trackIds.length !== 4 || new Set(manifest.trackIds).size !== 4 || !["initial", "updated"].includes(phase)) throw new Error("invalid_manifest");
  validateDesired({ playlistKey: manifest.playlistKey, revision: 1, trackIds: manifest.trackIds });
  const [A, B, C, D] = manifest.trackIds;
  const revision = phase === "initial" ? 1 : 2;
  const trackIds = phase === "initial" ? [A, B, C] : [C, A, D];
  if (phase === "updated" && (!initial || initial.schemaVersion !== 1 || !initial.verified || initial.phase !== "initial" || !equal(initial.manifest, manifest)
    || !initial.observation || !/^[A-Za-z0-9]{22}$/.test(initial.observation.providerPlaylistId) || initial.observation.appliedRevision !== 1
    || !equal(initial.observation.trackUris, [A, B, C].map(id => `spotify:track:${id}`)))) throw new Error("initial_evidence_required");
  const status = await request("/control/status") as { authorized?: boolean; publisherId?: string; appMode?: string; destinations?: { playlistKey: string; providerPlaylistId: string | null; revision: number; createUnresolved: boolean }[] } | null;
  if (!status?.authorized || status.publisherId !== manifest.publisherId || status.appMode !== manifest.appMode) throw new Error("publisher_confirmation_required");
  if (!Array.isArray(status.destinations)) throw new Error("invalid_control_response");
  const destination = status.destinations.find(row => row.playlistKey === manifest.playlistKey);
  if (destination?.createUnresolved) throw new Error("create_unresolved");
  if (destination && destination.revision > revision) throw new Error("stale_revision");
  if (phase === "updated" && destination?.providerPlaylistId !== initial!.observation.providerPlaylistId) throw new Error("destination_identity_changed");
  let writtenId: string | undefined;
  if (options.publish) {
    const result = await request("/control/desired", "PUT", { playlistKey: manifest.playlistKey, revision, trackIds }) as { providerPlaylistId?: string; appliedRevision?: number } | null;
    if (!result || typeof result.providerPlaylistId !== "string" || !/^[A-Za-z0-9]{22}$/.test(result.providerPlaylistId) || result.appliedRevision !== revision) throw new Error("invalid_publication_receipt");
    writtenId = result.providerPlaylistId;
  }
  const observation = await request(`/control/readback?playlistKey=${encodeURIComponent(manifest.playlistKey)}`) as Observation | null;
  if (!observation || !Array.isArray(observation.trackUris) || observation.trackUris.some(uri => typeof uri !== "string")
    || typeof observation.snapshotId !== "string" || !observation.snapshotId || !Number.isFinite(observation.observedAt)
    || typeof observation.providerPlaylistId !== "string" || !/^[A-Za-z0-9]{22}$/.test(observation.providerPlaylistId)) throw new Error("invalid_readback_receipt");
  const verified = observation.playlistKey === manifest.playlistKey && observation.publisherId === manifest.publisherId && observation.revision === revision
    && observation.appliedRevision === revision && observation.matchesDesired === true && equal(observation.trackUris, trackIds.map(id => `spotify:track:${id}`))
    && (!writtenId || observation.providerPlaylistId === writtenId) && (phase === "initial" || observation.providerPlaylistId === initial!.observation.providerPlaylistId);
  return { schemaVersion: 1, manifest, phase, verified, observation, listenerVerification: "pending" };
}

export function controlClient(token: string, fetcher: typeof fetch = fetch): RequestControl {
  if (typeof token !== "string" || token.length < 32) throw new Error("operator_secret_required");
  return async (path, method = "GET", body) => {
    if (!/^\/control\/(status|desired|readback(?:\?playlistKey=[A-Za-z0-9_-]+)?)$/.test(path)) throw new Error("invalid_control_path");
    let response;
    try {
      response = await fetcher(origin + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30000) });
    } catch { throw new Error(method === "GET" ? "control_unavailable" : "control_write_outcome_unknown"); }
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error(method === "GET" ? "invalid_control_response" : "control_write_outcome_unknown"); }
    if (!response.ok) {
      const code = (value as { error?: unknown } | null)?.error;
      const seconds = Number(response.headers.get("retry-after"));
      const name = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) && !code.includes(token) ? code : "control_error";
      throw new Error(`${name}: HTTP ${response.status}${response.status === 429 && Number.isFinite(seconds) && seconds > 0 ? `; retry after ${Math.ceil(seconds)} seconds` : ""}`);
    }
    return value;
  };
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, phase: { type: "string" }, initial: { type: "string" }, output: { type: "string" }, publish: { type: "boolean", default: false } } });
  if (!values.manifest || !values.output || !["initial", "updated"].includes(values.phase ?? "")) throw new Error("usage: --manifest file --phase initial|updated --output new-file [--initial first-receipt] [--publish]");
  const manifest = JSON.parse(await readFile(values.manifest, "utf8")) as Manifest;
  const initial = values.initial ? JSON.parse(await readFile(values.initial, "utf8")) as Receipt : undefined;
  const secrets = JSON.parse(await readFile(join(homedir(), ".local/state/songlink/spotify-publisher-staging/secrets.json"), "utf8"));
  const file = await open(values.output, "wx", 0o600);
  try {
    const receipt = await runPhase({ manifest, phase: values.phase as Phase, publish: values.publish, initial, request: controlClient(secrets.OPERATOR_TOKEN) });
    await file.writeFile(JSON.stringify({ ...receipt, controlOrigin: origin, capturedAt: new Date().toISOString() }, null, 2) + "\n");
    console.log(JSON.stringify({ verified: receipt.verified, phase: receipt.phase, playlistUrl: `https://open.spotify.com/playlist/${receipt.observation.providerPlaylistId}`, evidence: values.output, listenerVerification: "pending" }));
    if (!receipt.verified) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "live_test_failed";
    await file.writeFile(JSON.stringify({ verified: false, phase: values.phase, failure: message, capturedAt: new Date().toISOString() }, null, 2) + "\n");
    throw error;
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error instanceof Error ? error.message : "live_test_failed"); process.exitCode = 1; });
