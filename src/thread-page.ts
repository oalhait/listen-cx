import {
  MANAGEMENT_ACTION_HEADER,
  MANAGEMENT_ACTION_VALUE,
} from "./thread-security.js";
import { DESIGN_TOKENS } from "./design-system.js";
import { esc } from "./page.js";

export type ThreadState = "open" | "full" | "exhausted" | "closed";
export type ThreadStatusTone = "info" | "success" | "error";

export interface ThreadStatusView {
  tone: ThreadStatusTone;
  message: string;
}

export interface ThreadCreationPageModel {
  createAction: string;
  initialTitle?: string;
  status?: ThreadStatusView;
}

export interface ThreadSongView {
  contributionId: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  canonicalUrl: string;
  removeAction?: string;
}

export interface ThreadPageActions {
  add: string;
  activateManagement: string;
  close?: string;
  fragment?: string;
  subscribeNotifications?: string;
}

export interface ThreadAppleMusicView {
  developerTokenAction: string;
  spikeAction: string;
}

export interface ThreadPageModel {
  title: string;
  publicUrl: string;
  state: ThreadState;
  managed: boolean;
  actions: ThreadPageActions;
  songs: readonly ThreadSongView[];
  appleMusic?: ThreadAppleMusicView;
  addValue?: string;
  status?: ThreadStatusView;
  notifications?: {
    vapidPublicKey: string;
    serviceWorkerUrl: string;
  };
}

function safeUrl(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) return esc(value);
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? esc(value) : "#";
  } catch {
    return "#";
  }
}

function statusRegion(status?: ThreadStatusView): string {
  return `<p class="status" id="page-status" role="status" aria-live="polite" data-tone="${status?.tone ?? "info"}">${status ? esc(status.message) : ""}</p>`;
}

const STYLES = `
  ${DESIGN_TOKENS}
  html,body { margin:0; min-height:100%; }
  html { background:var(--ls-night); }
  body { min-height:100vh; background:radial-gradient(circle at 74% 12%,rgba(255,128,104,.14),transparent 30rem),radial-gradient(circle at 12% 80%,rgba(158,219,215,.08),transparent 34rem),var(--ls-night); color:var(--ls-paper); font-family:var(--ls-sans); -webkit-font-smoothing:antialiased; }
  button:focus-visible,a:focus-visible,input:focus-visible { outline:3px solid var(--ls-focus); outline-offset:3px; }
  .shell { width:100%; max-width:980px; margin:0 auto; padding:22px clamp(20px,5vw,54px) 72px; }
  .brand { color:var(--ls-paper); font:600 17px/1 var(--ls-mono); letter-spacing:-.02em; text-decoration:none; }
  .topbar { display:flex; min-height:44px; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
  .topbar .button { min-height:40px; border-radius:8px; padding:8px 13px; font-size:13px; }
  main { display:grid; gap:14px; }
  .thread-hero { display:block; }
  .thread-summary { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 16px; }
  .eyebrow { margin:0 0 8px; color:var(--ls-coral); font:500 10px/1.2 var(--ls-mono); letter-spacing:.1em; text-transform:uppercase; }
  h1,h2,p { margin-top:0; }
  h1 { max-width:760px; margin-bottom:8px; color:var(--ls-paper); font:500 clamp(40px,6.2vw,64px)/.94 var(--ls-serif); letter-spacing:-.052em; }
  h2 { margin-bottom:12px; color:var(--ls-paper); font:500 24px/1.05 var(--ls-serif); letter-spacing:-.025em; }
  .lede { max-width:610px; margin-bottom:0; color:var(--ls-muted); font-size:14px; line-height:1.45; }
  .state { display:inline-flex; min-height:28px; flex:0 0 auto; align-items:center; border:1px solid var(--ls-line); border-radius:999px; padding:5px 9px; color:var(--ls-muted); font:500 10px/1 var(--ls-mono); letter-spacing:.04em; text-transform:uppercase; }
  .state[data-state="open"] { border-color:rgba(158,219,215,.5); color:var(--ls-ice); }
  .state[data-state="closed"] { border-color:rgba(255,154,145,.5); color:var(--ls-danger); }
  .private { margin:0; border-left:2px solid var(--ls-coral); padding:13px 16px; background:rgba(255,128,104,.08); color:#ffd0c5; font-size:14px; line-height:1.45; }
  .panel { border:1px solid var(--ls-line); border-radius:var(--ls-radius); padding:24px; background:rgba(16,39,45,.58); }
  .thread-tool { border-top:1px solid var(--ls-line); padding:28px 0 8px; }
  .thread-tool h2 { margin-bottom:16px; }
  .thread-add .form { grid-template-columns:minmax(0,1fr) auto; align-items:end; gap:10px; }
  .thread-add .form label { grid-column:1/-1; }
  .thread-add .form .button { min-width:128px; }
  .form { display:grid; gap:10px; }
  label { color:var(--ls-paper); font-size:14px; font-weight:650; }
  input { width:100%; min-height:54px; border:1px solid var(--ls-line-strong); border-radius:10px; padding:0 14px; outline:none; background:rgba(11,23,26,.48); color:var(--ls-paper); font-family:var(--ls-mono); }
  input::placeholder { color:var(--ls-faint); }
  input:focus { border-color:var(--ls-coral); box-shadow:0 0 0 3px rgba(255,128,104,.2); }
  .button,.button-link { display:inline-flex; min-height:48px; align-items:center; justify-content:center; border:1px solid transparent; border-radius:10px; padding:10px 16px; cursor:pointer; font-weight:700; line-height:1.2; text-align:center; text-decoration:none; transition:background 150ms ease,border-color 150ms ease,transform 150ms cubic-bezier(.34,1.56,.64,1),opacity 150ms ease; }
  .button:active,.button-link:active { transform:scale(.98); }
  .primary { background:var(--ls-coral); color:var(--ls-night); box-shadow:0 10px 26px rgba(255,128,104,.14); }
  .primary:hover { background:#ff957f; }
  .secondary { border-color:var(--ls-line-strong); background:rgba(20,47,54,.8); color:var(--ls-paper); }
  .secondary:hover { border-color:var(--ls-ice); background:rgba(25,59,67,.9); }
  .danger { border-color:rgba(255,154,145,.45); background:rgba(255,154,145,.08); color:var(--ls-danger); }
  .plain { border-color:transparent; background:transparent; color:var(--ls-muted); }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .status { min-height:22px; margin:0; color:var(--ls-muted); font-size:14px; line-height:1.45; }
  .status[data-tone="error"] { color:var(--ls-danger); }
  .status[data-tone="success"] { color:var(--ls-ice); }
  .notice { margin:0; border-left:2px solid var(--ls-line-strong); padding:12px 14px; background:rgba(241,238,229,.04); color:var(--ls-muted); line-height:1.45; }
  .stack-experience { position:relative; isolation:isolate; width:min(100%,840px); margin:0 auto 44px; }
  .stack-stage { --case-size:164px; --rack-step:124px; position:relative; min-width:0; padding:10px 0 22px; perspective:900px; }
  .stack-stage::before { position:absolute; top:4%; right:5%; bottom:4%; left:16%; z-index:-2; border-radius:50%; background:rgba(158,219,215,.035); content:""; filter:blur(38px); pointer-events:none; }
  .rack-frame { position:absolute; top:22px; bottom:22px; left:84px; z-index:-1; width:calc(var(--case-size) + 42px); pointer-events:none; }
  .rack-post { position:absolute; top:0; bottom:14px; width:4px; border:1px solid rgba(241,238,229,.2); border-radius:999px; background:linear-gradient(90deg,#3c4744,#9c9b8f 42%,#535e59 72%,#28322f); box-shadow:4px 0 12px rgba(0,0,0,.2); }
  .rack-post::before { position:absolute; top:-6px; left:50%; width:8px; height:8px; border:1px solid rgba(241,238,229,.2); border-radius:50%; background:#59635e; content:""; transform:translateX(-50%); }
  .rack-post-left { left:0; }
  .rack-post-right { right:0; }
  .rack-base { position:absolute; right:-13px; bottom:0; left:-13px; height:15px; border:1px solid rgba(241,238,229,.18); border-radius:3px 3px 6px 6px; background:linear-gradient(180deg,#77766c,#343d39 48%,#1a2421); box-shadow:0 12px 22px rgba(0,0,0,.26); }
  .cd-stack { position:relative; width:100%; margin:0; padding:48px 0 82px 100px; list-style:none; transform-style:preserve-3d; }
  .cd-case { position:relative; z-index:1; height:var(--rack-step); transform-style:preserve-3d; }
  .cd-case[data-stack-state="active"] { z-index:30; }
  .rack-slot-support { position:absolute; top:calc((var(--rack-step) + var(--case-size)) / 2 - 10px); left:-13px; z-index:-1; width:calc(var(--case-size) + 28px); height:4px; border-radius:999px; background:linear-gradient(180deg,rgba(198,196,181,.84),rgba(69,79,74,.94)); box-shadow:0 5px 9px rgba(0,0,0,.28); pointer-events:none; }
  .case-select { position:relative; display:grid; width:min(100%,720px); height:var(--rack-step); grid-template-columns:var(--case-size) minmax(0,1fr); gap:28px; align-items:center; border:0; padding:0; background:transparent; color:inherit; cursor:pointer; text-align:left; transform:translate3d(var(--case-offset,0px),0,0) rotateZ(var(--case-rotate,0deg)); transform-origin:calc(var(--case-size) / 2) 50%; transform-style:preserve-3d; transition:transform 250ms cubic-bezier(.2,.8,.2,1),filter 220ms ease; }
  .case-select:focus-visible { outline:none; }
  .case-select:focus-visible .jewel-case { box-shadow:0 0 0 3px var(--ls-focus),0 18px 28px rgba(0,0,0,.34); }
  .cd-case:not([data-stack-state="active"]) .case-select { filter:saturate(.9) brightness(.9); }
  .cd-case[data-stack-state="active"] .case-select { filter:none; transform:translate3d(0,-2px,58px) rotateZ(0deg) scale(1.035); }
  .jewel-case { position:relative; width:var(--case-size); height:var(--case-size); margin-top:calc((var(--rack-step) - var(--case-size)) / 2); overflow:hidden; border:1px solid rgba(241,238,229,.46); border-radius:5px; background:linear-gradient(125deg,rgba(241,238,229,.18),rgba(241,238,229,.045) 30%,rgba(11,23,26,.18)); box-shadow:0 13px 23px rgba(0,0,0,.27),0 2px 0 rgba(241,238,229,.16),inset 0 0 0 1px rgba(241,238,229,.08); isolation:isolate; transition:border-color 220ms ease,box-shadow 250ms ease; }
  .jewel-case::before { position:absolute; inset:7px; z-index:4; border:1px solid rgba(241,238,229,.22); border-radius:2px; box-shadow:inset 0 0 0 1px rgba(11,23,26,.22); content:""; pointer-events:none; }
  .jewel-case::after { position:absolute; top:-18%; right:3%; z-index:5; width:22%; height:136%; background:linear-gradient(90deg,transparent,rgba(255,255,255,.19),transparent); content:""; opacity:.55; transform:rotate(18deg); pointer-events:none; }
  .cd-case[data-stack-state="active"] .jewel-case { border-color:rgba(241,238,229,.72); box-shadow:10px 28px 42px rgba(0,0,0,.42),0 0 0 1px rgba(158,219,215,.2),0 4px 0 rgba(241,238,229,.34),inset 0 0 0 1px rgba(241,238,229,.12); }
  .cd-case[data-stack-state="active"] .jewel-case::before { border-bottom-color:rgba(241,238,229,.66); }
  .case-spine { position:absolute; top:8px; bottom:8px; left:7px; z-index:6; display:flex; width:11px; align-items:center; justify-content:center; border-right:1px solid rgba(241,238,229,.2); background:rgba(11,23,26,.2); }
  .case-spine-index { color:var(--case-accent,var(--ls-coral)); font:600 7px/1 var(--ls-mono); letter-spacing:.05em; writing-mode:vertical-rl; }
  .case-insert { position:absolute; inset:8px 8px 8px 18px; overflow:hidden; border-radius:1px; background:rgba(16,39,45,.42); }
  .case-art { display:block; width:100%; height:100%; border:0; object-fit:cover; }
  .case-art-placeholder { width:100%; height:100%; background:linear-gradient(145deg,rgba(255,128,104,.7),rgba(175,161,255,.42) 50%,rgba(158,219,215,.48)); }
  .case-copy { display:grid; min-width:0; align-content:center; gap:5px; padding:5px 16px 42px 0; }
  .case-title { display:-webkit-box; overflow:hidden; max-width:440px; color:var(--ls-paper); font:500 clamp(18px,2.2vw,21px)/1.08 var(--ls-serif); letter-spacing:-.025em; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
  .case-artist { overflow:hidden; max-width:440px; color:rgba(241,238,229,.7); font-size:13px; line-height:1.25; text-overflow:ellipsis; white-space:nowrap; }
  .case-actions { position:absolute; top:76px; left:calc(var(--case-size) + 28px); z-index:4; display:flex; gap:6px; opacity:0; pointer-events:none; transform:translateY(4px); transition:opacity 180ms ease,transform 220ms ease,visibility 180ms ease; visibility:hidden; }
  .cd-case[data-stack-state="active"] .case-actions { opacity:1; pointer-events:auto; transform:translateY(0); visibility:visible; }
  .case-actions .button,.case-actions .button-link { min-width:0; min-height:36px; border-radius:7px; padding:7px 11px; font-size:11px; }
  .empty-stack { display:grid; min-height:300px; place-items:center; text-align:center; }
  .empty-stack p { max-width:340px; color:var(--ls-muted); line-height:1.5; }
  .link-output { overflow-wrap:anywhere; border:1px solid var(--ls-line); border-radius:10px; padding:12px; background:rgba(11,23,26,.4); color:var(--ls-paper); font-family:var(--ls-mono); font-size:13px; }
  .warning { color:var(--ls-danger); font-size:13px; line-height:1.45; }
  [hidden] { display:none!important; }
  @media (max-width:760px) {
    .shell { padding-inline:18px; }
    .topbar { margin-bottom:12px; }
    h1 { font-size:clamp(38px,11vw,52px); }
    .lede { font-size:13px; }
    .stack-experience { width:calc(100% + 20px); margin-right:-10px; margin-left:-10px; }
    .stack-stage { --case-size:116px; --rack-step:102px; padding-block:8px 18px; }
    .rack-frame { top:18px; bottom:18px; left:6px; width:calc(var(--case-size) + 32px); }
    .rack-post { width:3px; }
    .rack-base { right:-8px; left:-8px; height:12px; }
    .cd-stack { padding:34px 8px 56px 22px; }
    .case-select { width:100%; grid-template-columns:var(--case-size) minmax(0,1fr); gap:15px; }
    .rack-slot-support { left:-9px; width:calc(var(--case-size) + 20px); height:3px; }
    .case-copy { gap:3px; padding:4px 14px 36px 0; }
    .case-title { max-width:none; font-size:17px; }
    .case-artist { max-width:none; color:rgba(241,238,229,.74); font-size:12px; }
    .case-actions { top:64px; left:calc(var(--case-size) + 15px); }
    .case-actions .button,.case-actions .button-link { min-height:35px; padding-inline:9px; font-size:10px; }
    .thread-add .form { grid-template-columns:1fr; }
    .thread-add .form label { grid-column:auto; }
    .cd-case[data-stack-state="active"] .case-select { transform:translate3d(0,-1px,44px) rotateZ(0deg) scale(1.025); }
    .actions>.button,.actions>.button-link { width:100%; }
  }
  @media (max-width:480px) {
    .stack-stage { --case-size:106px; --rack-step:96px; }
    .rack-frame { left:0; width:calc(var(--case-size) + 26px); }
    .cd-stack { padding-right:0; padding-left:14px; }
    .case-select { gap:12px; }
    .case-copy { padding-right:12px; padding-bottom:35px; }
    .case-title { font-size:16px; }
    .case-artist { font-size:12px; }
    .case-actions { top:60px; left:calc(var(--case-size) + 12px); gap:4px; }
    .case-actions .button,.case-actions .button-link { min-height:33px; padding:6px 7px; font-size:9.5px; }
  }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.01ms!important; animation-duration:.01ms!important; animation-iteration-count:1!important; }
    .case-select { transform:translateX(var(--case-offset,0px)) rotateZ(var(--case-rotate,0deg)); }
    .cd-case[data-stack-state="active"] .case-select { transform:none; }
  }
`;

const COPY_HELPERS = `
function setStatus(message,tone="info"){const pageStatus=document.getElementById("page-status");if(!pageStatus)return;pageStatus.textContent=message;pageStatus.dataset.tone=tone;}
function reportCopy(copied,successMessage,failureMessage){setStatus(copied?successMessage:failureMessage,copied?"success":"error");}
async function copyText(value){
  if(navigator.clipboard){const copied=await navigator.clipboard.writeText(value).then(()=>true,()=>false);if(copied)return true;}
  const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();const copied=document.execCommand("copy");area.remove();return copied;
}`;

function documentHead(title: string, description: string, artworkUrl?: string | null): string {
  const artwork = artworkUrl ? safeUrl(artworkUrl) : null;
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">
${artwork && artwork !== "#" ? `<meta property="og:image" content="${artwork}">` : ""}<style>${STYLES}</style>`;
}

export function threadCreationPage(model: ThreadCreationPageModel): string {
  const title = model.initialTitle ?? "";
  return `<!doctype html><html lang="en"><head>${documentHead("Start a Thread — listen.cx", "Build a playlist together across Spotify and Apple Music.")}</head><body>
<div class="shell"><header class="topbar"><a class="brand" href="/">listen.cx</a></header><main>
  <section id="create-thread-view">
    <p class="eyebrow">Pass the aux</p><h1>Start a Thread</h1>
    <p class="lede">Name the moment, send one link, and let friends add songs from Spotify or Apple Music.</p>
    <div class="panel"><form class="form" id="create-thread-form" action="${safeUrl(model.createAction)}" method="post" novalidate>
      <label for="thread-title">Thread title</label>
      <input id="thread-title" name="title" value="${esc(title)}" maxlength="80" autocomplete="off" required aria-describedby="title-help page-status">
      <p class="status" id="title-help">Use 1–80 characters.</p>
      <button class="button primary" id="create-thread-submit" type="submit">Create Thread</button>
    </form></div>
  </section>
  <section id="create-thread-success" hidden>
    <p class="eyebrow">Ready to send</p><h1>Your Thread is ready</h1>
    <p class="lede">Share the public link with everyone who should add songs.</p>
    <p class="link-output" id="created-public-url"></p>
    <div class="actions">
      <button class="button primary" id="share-created-thread" type="button">Share Thread</button>
      <button class="button secondary" id="copy-created-thread" type="button">Copy Thread link</button>
    </div>
    <div class="panel">
      <h2>Keep your private link</h2>
      <p class="warning">Anyone with this private link can remove songs or close the Thread.</p>
      <div class="actions">
        <button class="button secondary" id="save-management-link" type="button">Save private management link</button>
        <a class="button-link plain" id="open-management-view" href="#" hidden>Open management view</a>
      </div>
    </div>
  </section>
  ${statusRegion(model.status)}
</main></div>
<script>
const createForm=document.getElementById("create-thread-form");
const createView=document.getElementById("create-thread-view");
const successView=document.getElementById("create-thread-success");
const titleInput=document.getElementById("thread-title");
const pageStatus=document.getElementById("page-status");
const createSubmit=document.getElementById("create-thread-submit");
let createdPublicUrl="";
let privateManagementUrl="";
let createInFlight=false;
${COPY_HELPERS}
function showCreated(data){
  createdPublicUrl=typeof data.publicUrl==="string"?data.publicUrl:"";
  privateManagementUrl=typeof data.managementUrl==="string"?data.managementUrl:"";
  if(!createdPublicUrl||!privateManagementUrl){setStatus("The Thread was created, but its links could not be shown. Reload and try again.","error");return;}
  location.assign(privateManagementUrl);
}
createForm.addEventListener("submit",async(event)=>{
  event.preventDefault();if(createInFlight)return;const title=titleInput.value.trim();
  if(!title){setStatus("Enter a Thread title.","error");titleInput.focus();return;}
  createInFlight=true;titleInput.disabled=true;createSubmit.disabled=true;createSubmit.textContent="Creating…";setStatus("Creating your Thread…");
  try{
    const response=await fetch(createForm.action,{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"create-thread"},body:JSON.stringify({title})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){setStatus(typeof data.error==="string"?data.error:"Couldn’t create this Thread. Try again.","error");return;}
    showCreated(data);
  }catch{setStatus("Couldn’t create this Thread. Check your connection and try again.","error");}
  finally{createInFlight=false;titleInput.disabled=false;createSubmit.disabled=false;createSubmit.textContent="Create Thread";}
});
document.getElementById("copy-created-thread").addEventListener("click",async()=>{reportCopy(await copyText(createdPublicUrl),"Public Thread link copied.","Select and copy the public link above.");});
document.getElementById("share-created-thread").addEventListener("click",async()=>{
  if(navigator.share){try{await navigator.share({title:titleInput.value.trim(),url:createdPublicUrl});return;}catch(error){if(error&&error.name==="AbortError")return;}}
  reportCopy(await copyText(createdPublicUrl),"Public Thread link copied.","Select and copy the public link above.");
});
document.getElementById("save-management-link").addEventListener("click",async()=>{reportCopy(await copyText(privateManagementUrl),"Private management link copied. Save it somewhere safe.","Couldn’t copy the private link. Use the private link below before opening it.");});
</script></body></html>`;
}

function caseAccent(index: number): string {
  return ["#FF8068", "#9EDBD7", "#AFA1FF", "#F1EEE5"][index % 4] ?? "#FF8068";
}

function caseStyle(index: number): string {
  const offsets = [-3, 4, -1, 3, 0, -4];
  const rotations = [-0.32, 0.24, -0.18, 0.3, -0.12, 0.2];
  return `--case-offset:${offsets[index % offsets.length] ?? 0}px;--case-rotate:${rotations[index % rotations.length] ?? 0}deg;--case-accent:${caseAccent(index)};`;
}

function songCase(song: ThreadSongView, index: number, managed: boolean): string {
  const artwork = song.artworkUrl ? safeUrl(song.artworkUrl) : null;
  const canonicalUrl = safeUrl(song.canonicalUrl);
  const ordinal = String(index + 1).padStart(2, "0");
  const remove =
    managed && song.removeAction
      ? `<button class="button danger" type="button" data-remove-action="${safeUrl(song.removeAction)}" aria-label="Remove ${esc(song.title)}">Remove</button>`
      : "";
  return `<li class="cd-case" data-stack-case="${index}" data-stack-state="${index === 0 ? "active" : "queued"}" data-contribution-id="${esc(song.contributionId)}" style="${caseStyle(index)}" aria-labelledby="case-title-${index}">
    <span class="rack-slot-support" aria-hidden="true"></span>
    <button class="case-select" type="button" data-select-case="${index}" aria-label="Select ${esc(song.title)} by ${esc(song.artist)}" aria-pressed="${index === 0 ? "true" : "false"}">
      <span class="jewel-case" aria-hidden="true"><span class="case-spine"><span class="case-spine-index">${ordinal}</span></span><span class="case-insert">${artwork && artwork !== "#" ? `<img class="case-art" src="${artwork}" alt="">` : `<span class="case-art-placeholder"></span>`}</span></span>
      <span class="case-copy"><span class="case-title" id="case-title-${index}">${esc(song.title)}</span><span class="case-artist">${esc(song.artist)}</span></span>
    </button>
    <div class="case-actions"><a class="button-link secondary" href="${canonicalUrl}" data-open-song>Open song</a><button class="button plain" type="button" data-copy-song="${canonicalUrl}">Copy</button>${remove}</div>
  </li>`;
}

function stackExperience(model: ThreadPageModel): string {
  return `<section class="stack-experience" data-stack-experience data-stack-count="${model.songs.length}" aria-label="Thread CD rack">
    <div class="stack-stage">
      <div class="rack-frame" aria-hidden="true"><span class="rack-post rack-post-left"></span><span class="rack-post rack-post-right"></span><span class="rack-base"></span></div>
      <ol class="cd-stack" aria-label="Songs in chronological order">${model.songs.map((song, index) => songCase(song, index, model.managed)).join("")}</ol>
    </div>
  </section>`;
}

function addSection(model: ThreadPageModel): string {
  if (model.state === "closed") {
    return `<section class="thread-tool"><h2>Contributions are closed</h2><p class="notice">This Thread is still available to listen to and share. This cannot be reopened.</p></section>`;
  }
  if (model.state === "full") {
    const guidance = model.managed
      ? "Remove a song to make room. Closing the Thread will keep its current songs."
      : "This Thread is full. The creator can remove a song to make room.";
    return `<section class="thread-tool"><h2>This Thread is full</h2><p class="notice">${guidance}</p></section>`;
  }
  if (model.state === "exhausted") {
    return `<section class="thread-tool"><h2>Contributions are complete</h2><p class="notice">This Thread reached its lifetime contribution limit. Its songs remain openable and shareable.</p></section>`;
  }
  return `<section class="thread-tool thread-add"><h2>${model.songs.length ? "Add a song" : "Add the first song"}</h2>
    <form class="form" id="add-song-form" action="${safeUrl(model.actions.add)}" method="post" novalidate>
      <label for="song-url">Spotify or Apple Music song link</label>
      <input id="song-url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(model.addValue ?? "")}" placeholder="https://open.spotify.com/track/…" aria-describedby="page-status">
      <button class="button primary" id="add-song-submit" type="submit">Add song</button>
    </form>
  </section>`;
}

function threadContent(model: ThreadPageModel): string {
  const stateLabel = model.state === "closed" ? "Closed" : model.state === "full" ? "Full" : model.state === "exhausted" ? "Complete" : "Open";
  const closeAction = model.managed && model.state !== "closed" && model.actions.close ? safeUrl(model.actions.close) : null;
  const songLabel = `${model.songs.length} ${model.songs.length === 1 ? "song" : "songs"}`;
  return `<section class="thread-hero"><p class="eyebrow">Pass the aux</p><h1>${esc(model.title)}</h1><div class="thread-summary"><p class="lede">${songLabel} on the rack, in the order they were added.</p><span class="state" data-state="${model.state}">${stateLabel}</span></div></section>
  ${model.managed ? `<p class="private"><strong>Private management view.</strong> Share only with the Share Thread button, which always uses the public link.</p>` : ""}
  ${statusRegion(model.status)}
  ${model.songs.length ? stackExperience(model) : `<section class="panel empty-stack"><div><h2>No songs yet</h2><p>Add the first song to start the Thread.</p></div></section>`}
  ${addSection(model)}
  ${model.appleMusic ? `<section class="panel"><h2>Try an Apple Music playlist</h2><p class="notice">Staging proof only: this creates one private playlist from the Thread’s matched Apple Music songs. It does not keep syncing yet.</p><button class="button secondary" type="button" data-apple-music-spike data-token-action="${safeUrl(model.appleMusic.developerTokenAction)}" data-spike-action="${safeUrl(model.appleMusic.spikeAction)}">Create Apple Music playlist</button><p class="status" id="apple-music-status" role="status" aria-live="polite"></p></section>` : ""}
  ${model.notifications ? `<section class="panel"><h2>Keep up with this Thread</h2><p class="notice">Get a notification when someone adds a song, even after you close this tab.</p><button class="button secondary" type="button" data-notification-toggle data-notification-action="${safeUrl(model.actions.subscribeNotifications ?? "")}" data-vapid-public-key="${esc(model.notifications.vapidPublicKey)}" data-service-worker-url="${safeUrl(model.notifications.serviceWorkerUrl)}">Turn on notifications</button></section>` : ""}
  ${closeAction ? `<section class="panel"><h2>Stop contributions</h2><p class="notice">Closing is permanent. Songs stay openable and shareable, but nobody can add another song.</p><button class="button danger" type="button" data-close-action="${closeAction}">Close contributions</button></section>` : ""}`;
}

export function threadPageFragment(model: ThreadPageModel): string {
  return threadContent(model);
}

export function threadPage(model: ThreadPageModel): string {
  const description = `${model.songs.length} ${model.songs.length === 1 ? "song" : "songs"} in this listen.cx Thread.`;
  const firstArtwork = model.songs.find((song) => song.artworkUrl)?.artworkUrl;
  return `<!doctype html><html lang="en"><head>${documentHead(`${model.title} — listen.cx`, description, firstArtwork)}</head><body data-thread-state="${model.state}" data-managed="${model.managed ? "true" : "false"}" data-activation-action="${safeUrl(model.actions.activateManagement)}" data-fragment-action="${safeUrl(model.actions.fragment ?? "")}">
<div class="shell"><header class="topbar"><a class="brand" href="/">listen.cx</a><button class="button secondary" type="button" data-share-thread data-public-url="${safeUrl(model.publicUrl)}">Share Thread</button></header><main id="thread-main">
${threadContent(model)}</main></div>
<script>
const activationAction=document.body.dataset.activationAction||"";
const fragmentAction=document.body.dataset.fragmentAction||"";
const managementHeaders={"${MANAGEMENT_ACTION_HEADER}":"${MANAGEMENT_ACTION_VALUE}"};
${COPY_HELPERS}
async function activateManagement(){
  if(!location.hash.startsWith("#manage="))return;
  const cleanUrl=location.pathname+location.search;
  let token="";
  try{token=decodeURIComponent(location.hash.slice("#manage=".length));}
  catch{history.replaceState(null,"",cleanUrl);setStatus("That private management link is invalid or no longer available.","error");return;}
  let response;
  try{response=await fetch(activationAction,{method:"POST",headers:{"Content-Type":"application/json",...managementHeaders},body:JSON.stringify({token})});}
  catch{history.replaceState(null,"",cleanUrl);setStatus("That private management link could not be checked. Try opening it again.","error");return;}
  history.replaceState(null,"",cleanUrl);
  if(response.ok){location.reload();return;}
  setStatus("That private management link is invalid or no longer available.","error");
}
function reportSongAction(outcome){fetch("/api/thread-events",{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"thread-event"},body:JSON.stringify({outcome}),keepalive:true}).catch(()=>{});}
function bindShareControl(){
  const button=document.querySelector("[data-share-thread]");if(!button)return;
  button.addEventListener("click",async()=>{const url=button.dataset.publicUrl||"";if(navigator.share){try{await navigator.share({title:document.title,url});return;}catch(error){if(error&&error.name==="AbortError")return;}}reportCopy(await copyText(url),"Public Thread link copied.","Couldn’t share the Thread link.");});
}
let stackCleanup=()=>{};
function bindStackExperience(preferredContributionId=""){
  stackCleanup();
  const experience=document.querySelector("[data-stack-experience]");
  if(!experience)return;
  const cases=[...experience.querySelectorAll("[data-stack-case]")];
  const selectors=[...experience.querySelectorAll("[data-select-case]")];
  if(!cases.length)return;
  const preferredIndex=cases.findIndex((caseElement)=>caseElement.dataset.contributionId===preferredContributionId);
  let activeIndex=preferredIndex>=0?preferredIndex:0;
  function applyStack(index){
    const next=Math.max(0,Math.min(index,cases.length-1));
    activeIndex=next;
    experience.dataset.stackActiveIndex=String(next);
    cases.forEach((caseElement,caseIndex)=>{
      const active=caseIndex===next;
      caseElement.dataset.stackState=active?"active":caseIndex<next?"past":"queued";
    });
    selectors.forEach((selector,selectorIndex)=>{selector.setAttribute("aria-pressed",String(selectorIndex===next));});
  }
  applyStack(activeIndex);
  const reduced=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  selectors.forEach((selector,index)=>{
    selector.addEventListener("click",()=>{applyStack(index);cases[index].scrollIntoView({behavior:reduced?"auto":"smooth",block:"center"});});
    selector.addEventListener("keydown",(event)=>{
      if(event.key!=="ArrowDown"&&event.key!=="ArrowUp")return;
      event.preventDefault();
      const direction=event.key==="ArrowDown"?1:-1;
      const next=Math.max(0,Math.min(index+direction,selectors.length-1));
      selectors[next].focus();
      applyStack(next);
      cases[next].scrollIntoView({behavior:reduced?"auto":"smooth",block:"center"});
    });
  });
  function nearestCase(){
    const center=window.innerHeight/2;
    let closest=activeIndex;
    let distance=Number.POSITIVE_INFINITY;
    cases.forEach((caseElement,index)=>{
      const rect=caseElement.getBoundingClientRect();
      if(rect.bottom<0||rect.top>window.innerHeight)return;
      const nextDistance=Math.abs(rect.top+rect.height/2-center);
      if(nextDistance<distance){distance=nextDistance;closest=index;}
    });
    return closest;
  }
  if("IntersectionObserver" in window){
    const observer=new IntersectionObserver(()=>{applyStack(nearestCase());},{rootMargin:"-42% 0px -42% 0px",threshold:[0,.25,.75,1]});
    cases.forEach((caseElement)=>observer.observe(caseElement));
    stackCleanup=()=>{observer.disconnect();};
    return;
  }
  const onScroll=()=>{applyStack(nearestCase());};
  window.addEventListener("scroll",onScroll,{passive:true});
  onScroll();
  stackCleanup=()=>{window.removeEventListener("scroll",onScroll);};
}
let refreshGeneration=0;
async function refreshThread(){
  if(!fragmentAction)return;
  const generation=++refreshGeneration;
  const activeContributionId=document.querySelector('[data-stack-case][data-stack-state="active"]')?.dataset.contributionId||"";
  const focusedCase=document.activeElement&&document.activeElement.closest?document.activeElement.closest("[data-stack-case]"):null;
  const focusedContributionId=focusedCase?.dataset.contributionId||"";
  const response=await fetch(fragmentAction,{headers:{"X-Requested-With":"listen-thread"}});
  const data=await response.json().catch(()=>({}));
  if(generation!==refreshGeneration||!response.ok||typeof data.html!=="string")return;
  const main=document.getElementById("thread-main");if(!main)return;
  main.innerHTML=data.html;bindThreadControls(activeContributionId);
  if(focusedContributionId){const nextCase=[...document.querySelectorAll("[data-stack-case]")].find((caseElement)=>caseElement.dataset.contributionId===focusedContributionId);nextCase?.querySelector("[data-select-case]")?.focus({preventScroll:true});}
}
function bindThreadControls(preferredContributionId=""){
for(const link of document.querySelectorAll("[data-open-song]")){link.addEventListener("click",()=>{reportSongAction("opened");});}
for(const button of document.querySelectorAll("[data-copy-song]")){button.addEventListener("click",async()=>{const copied=await copyText(button.dataset.copySong||"");reportCopy(copied,"Song link copied.","Couldn’t copy the song link.");if(copied)reportSongAction("copied");});}
for(const button of document.querySelectorAll("[data-copy-thread]")){button.addEventListener("click",async()=>{reportCopy(await copyText(button.dataset.publicUrl||""),"Public Thread link copied.","Couldn’t copy the Thread link.");});}
const addForm=document.getElementById("add-song-form");
if(addForm){
  const input=document.getElementById("song-url");const submit=document.getElementById("add-song-submit");let requestKey="";let addInFlight=false;
  input.addEventListener("input",()=>{requestKey="";});
  addForm.addEventListener("submit",async(event)=>{
    event.preventDefault();if(addInFlight)return;const url=input.value.trim();if(!url){setStatus("Paste a Spotify or Apple Music song link.","error");input.focus();return;}
    addInFlight=true;requestKey=requestKey||(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());input.disabled=true;submit.disabled=true;submit.textContent="Adding…";setStatus("Finding that song…");
    try{const response=await fetch(addForm.action,{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"add-song"},body:JSON.stringify({url,requestKey})});const data=await response.json().catch(()=>({}));if(response.ok){await refreshThread();setStatus("Song added.","success");return;}setStatus(typeof data.error==="string"?data.error:"Couldn’t add that song. Try again.","error");}
    catch{setStatus("Couldn’t add that song. Check your connection and try again.","error");}
    finally{addInFlight=false;input.disabled=false;submit.disabled=false;submit.textContent="Add song";}
  });
}
for(const button of document.querySelectorAll("[data-remove-action]")){button.addEventListener("click",async()=>{button.disabled=true;try{const response=await fetch(button.dataset.removeAction||"",{method:"POST",headers:managementHeaders});if(response.ok){await refreshThread();setStatus("Song removed.","success");return;}const data=await response.json().catch(()=>({}));setStatus(typeof data.error==="string"?data.error:"Couldn’t remove that song.","error");}catch{setStatus("Couldn’t remove that song. Try again.","error");}finally{button.disabled=false;}});}
const closeButton=document.querySelector("[data-close-action]");
if(closeButton){closeButton.addEventListener("click",async()=>{if(!confirm("Close contributions permanently? This Thread cannot be reopened."))return;closeButton.disabled=true;try{const response=await fetch(closeButton.dataset.closeAction||"",{method:"POST",headers:managementHeaders});if(response.ok){await refreshThread();setStatus("Contributions closed.","success");return;}const data=await response.json().catch(()=>({}));setStatus(typeof data.error==="string"?data.error:"Couldn’t close this Thread.","error");}catch{setStatus("Couldn’t close this Thread. Try again.","error");}finally{closeButton.disabled=false;}});}
bindNotificationToggle();
bindAppleMusicSpike();
bindStackExperience(preferredContributionId);
}
let appleMusicInstance=null;
async function loadAppleMusic(){
  if(window.MusicKit)return window.MusicKit;
  await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src="https://js-cdn.music.apple.com/musickit/v1/musickit.js";script.onload=resolve;script.onerror=reject;document.head.append(script);});
  if(!window.MusicKit)throw new Error("MusicKit unavailable");
  return window.MusicKit;
}
function isAppleMusicUserToken(value){return typeof value==="string"&&value.length>=20;}
function appleMusicMessage(data){
  if(typeof data==="string"){try{return JSON.parse(data);}catch{return null;}}
  return data&&typeof data==="object"?data:null;
}
function appleMusicTokenFromMessage(message){
  const result=message&&typeof message.result==="object"&&message.result!==null?message.result:null;
  const params=Array.isArray(message&&message.params)?message.params:[];
  const candidates=[message&&message.musicUserToken,result&&result.musicUserToken,message&&message.method==="authorize"?params[0]:null];
  return candidates.find(isAppleMusicUserToken)||null;
}
function requestAppleMusicUserToken(instance){
  const storekit=instance&&instance.storekit;
  if(!storekit||typeof storekit.requestUserToken!=="function")return instance.authorize();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;window.removeEventListener("message",onMessage);window.clearTimeout(timeout);
      error?reject(error):resolve(value);
    };
    const onMessage=(event)=>{
      if(!["https://authorize.music.apple.com","https://idmsa.apple.com","https://appleid.apple.com"].includes(event.origin))return;
      const message=appleMusicMessage(event.data);if(!message)return;
      const token=appleMusicTokenFromMessage(message);if(token){finish(null,token);return;}
      if(["close","decline","switchUserId","unavailable"].includes(message.method))finish(new Error("Apple Music authorization was canceled."));
    };
    const timeout=window.setTimeout(()=>finish(new Error("Apple Music authorization did not finish. Try again.")),60000);
    window.addEventListener("message",onMessage);
    try{
      Promise.resolve(storekit.requestUserToken.call(storekit)).then((token)=>{
        if(isAppleMusicUserToken(token))finish(null,token);else finish(new Error("Apple Music authorization was canceled."));
      },(error)=>finish(error instanceof Error?error:new Error("Apple Music authorization failed.")));
    }catch(error){finish(error instanceof Error?error:new Error("Apple Music authorization failed."));}
  });
}
async function bindAppleMusicSpike(){
  const button=document.querySelector("[data-apple-music-spike]");const status=document.getElementById("apple-music-status");
  if(!button||!status)return;
  button.addEventListener("click",async()=>{
    button.disabled=true;status.textContent="Preparing Apple Music authorization…";
    try{
      const tokenResponse=await fetch(button.dataset.tokenAction||"",{headers:{accept:"application/json"}});const tokenData=await tokenResponse.json().catch(()=>({}));
      if(!tokenResponse.ok||typeof tokenData.developerToken!=="string")throw new Error("Apple Music is unavailable on this staging deployment.");
      const musicKit=await loadAppleMusic();
      if(!appleMusicInstance){await Promise.resolve(musicKit.configure({developerToken:tokenData.developerToken,storefrontId:typeof tokenData.storefrontId==="string"?tokenData.storefrontId:"us",features:["legacy-authenticate-method"]}));appleMusicInstance=musicKit.getInstance();}
      status.textContent="Approve access in Apple Music…";
      const musicUserToken=await requestAppleMusicUserToken(appleMusicInstance);
      if(typeof musicUserToken!=="string"||!musicUserToken)throw new Error("Apple Music authorization was canceled.");
      status.textContent="Creating the private playlist…";
      const response=await fetch(button.dataset.spikeAction||"",{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"apple-music-spike"},body:JSON.stringify({musicUserToken})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof data.error==="string"?data.error:"Apple Music could not create the playlist.");
      status.textContent=typeof data.trackCount==="number"?"Playlist created with "+data.trackCount+" matched song"+(data.trackCount===1?"":"s")+".":"Playlist created.";
      if(typeof data.playlistUrl==="string"){try{const url=new URL(data.playlistUrl);if(url.protocol==="https:"&&url.hostname.endsWith("apple.com")){const link=document.createElement("a");link.href=url.toString();link.target="_blank";link.rel="noreferrer";link.textContent=" Open it in Apple Music";status.append(link);}}catch{}}
    }catch(error){status.textContent=error instanceof Error?error.message:"Apple Music authorization failed. Try again.";}
    finally{button.disabled=false;}
  });
}
function decodeBase64Url(value){const padding="=".repeat((4-value.length%4)%4);const binary=atob(value.replace(/-/g,"+").replace(/_/g,"/")+padding);return Uint8Array.from(binary,(character)=>character.charCodeAt(0));}
async function bindNotificationToggle(){
  const button=document.querySelector("[data-notification-toggle]");if(!button||!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window))return;
  const registration=await navigator.serviceWorker.register(button.dataset.serviceWorkerUrl||"/t/thread-notifications-sw.js",{scope:"/t/"});
  const current=await registration.pushManager.getSubscription();button.textContent=current?"Turn off notifications":"Turn on notifications";
  button.addEventListener("click",async()=>{button.disabled=true;try{const subscription=await registration.pushManager.getSubscription();if(subscription){await fetch(button.dataset.notificationAction||"",{method:"DELETE",headers:{"Content-Type":"application/json","X-Listen-Action":"thread-notifications"},body:JSON.stringify({subscription:subscription.toJSON()})});await subscription.unsubscribe();button.textContent="Turn on notifications";setStatus("Notifications turned off.","success");return;}if(await Notification.requestPermission()!=="granted"){setStatus("Notifications are blocked in this browser.","error");return;}const next=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodeBase64Url(button.dataset.vapidPublicKey||"")});const response=await fetch(button.dataset.notificationAction||"",{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"thread-notifications"},body:JSON.stringify({subscription:next.toJSON()})});if(!response.ok){await next.unsubscribe();throw new Error("subscription rejected");}button.textContent="Turn off notifications";setStatus("You’ll be notified when someone adds a song.","success");}catch{setStatus("Couldn’t change notifications. Try again.","error");}finally{button.disabled=false;}});
}
let liveSocket=null;
let liveRetryTimer=0;
let liveRetryAttempt=0;
let liveStopped=false;
function scheduleLiveReconnect(){
  if(liveStopped||document.hidden||liveRetryTimer)return;
  const backoff=Math.min(30000,1000*(2**Math.min(liveRetryAttempt,5)));liveRetryAttempt+=1;
  liveRetryTimer=window.setTimeout(()=>{liveRetryTimer=0;connectLiveUpdates();},backoff+Math.floor(Math.random()*500));
}
function connectLiveUpdates(){
  if(liveStopped||document.hidden||liveSocket)return;
  const protocol=location.protocol==="https:"?"wss:":"ws:";let socket;
  try{socket=new WebSocket(protocol+"//"+location.host+location.pathname.replace(/^\\/t\\//,"/api/threads/")+"/live");}
  catch{scheduleLiveReconnect();return;}
  liveSocket=socket;
  socket.addEventListener("open",()=>{if(liveSocket===socket)liveRetryAttempt=0;});
  socket.addEventListener("message",()=>{refreshThread().catch(()=>{});});
  socket.addEventListener("error",()=>{socket.close();});
  socket.addEventListener("close",()=>{if(liveSocket!==socket)return;liveSocket=null;scheduleLiveReconnect();});
}
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!liveStopped&&!liveSocket&&!liveRetryTimer)connectLiveUpdates();});
window.addEventListener("pagehide",()=>{liveStopped=true;window.clearTimeout(liveRetryTimer);liveRetryTimer=0;const socket=liveSocket;liveSocket=null;if(socket)socket.close();},{once:true});
bindShareControl();
bindThreadControls();
connectLiveUpdates();
activateManagement();
</script></body></html>`;
}

export function threadNotificationServiceWorker(): string {
  return `self.addEventListener("push",(event)=>{const data=event.data?event.data.json():{};event.waitUntil(self.registration.showNotification(data.title||"A song was added",{body:data.body||"A Thread changed.",tag:data.tag,data:{url:data.url}}));});self.addEventListener("notificationclick",(event)=>{event.notification.close();event.waitUntil(clients.openWindow(event.notification.data&&event.notification.data.url||"/"));});`;
}
