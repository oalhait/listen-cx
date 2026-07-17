export type ThreadState = "open" | "full" | "closed";
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
}

export interface ThreadPageModel {
  title: string;
  publicUrl: string;
  state: ThreadState;
  managed: boolean;
  actions: ThreadPageActions;
  songs: readonly ThreadSongView[];
  addValue?: string;
  status?: ThreadStatusView;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
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
  :root { color-scheme:light dark; --orange:#ff7a00; --orange-dark:#dc6500; --espresso:#2b1706; --sunken:#3e2109; --cream:#fff3e8; --paper:#fffaf5; --ink:#24160c; --muted:#765f4a; --line:#d9c8b8; --danger:#a62d24; --focus:#ff9840; }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; }
  body { min-height:100vh; background:#f3eee7; color:var(--ink); font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  button,input,a { font:inherit; }
  button,a { -webkit-tap-highlight-color:transparent; }
  button:focus-visible,a:focus-visible,input:focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  .shell { width:min(100%,720px); margin:0 auto; padding:22px 18px 56px; }
  .brand { color:var(--espresso); font-size:18px; font-weight:800; letter-spacing:-.02em; text-decoration:none; }
  .topbar { display:flex; min-height:48px; align-items:center; justify-content:space-between; gap:12px; margin-bottom:34px; }
  main { display:grid; gap:24px; }
  .eyebrow { margin:0 0 8px; color:var(--orange-dark); font-size:12px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
  h1,h2,p { margin-top:0; }
  h1 { margin-bottom:10px; color:var(--espresso); font-size:clamp(34px,9vw,52px); line-height:1.02; letter-spacing:-.04em; }
  h2 { margin-bottom:12px; color:var(--espresso); font-size:20px; letter-spacing:-.02em; }
  .lede { max-width:560px; margin-bottom:0; color:var(--muted); font-size:16px; line-height:1.55; }
  .state { display:inline-flex; min-height:30px; align-items:center; border:1px solid var(--line); border-radius:999px; padding:4px 10px; background:var(--paper); color:var(--muted); font-size:13px; font-weight:700; }
  .state[data-state="open"] { border-color:#b6c9a3; color:#49612f; }
  .state[data-state="closed"] { border-color:#caa8a5; color:#7e312b; }
  .private { border-left:4px solid var(--orange); padding:12px 14px; background:#fff0e3; color:#70401d; font-size:14px; line-height:1.45; }
  .panel { border-top:1px solid var(--line); padding-top:22px; }
  .form { display:grid; gap:10px; }
  label { color:var(--espresso); font-size:14px; font-weight:750; }
  input { width:100%; min-height:52px; border:1px solid var(--line); border-radius:4px; padding:0 14px; background:var(--paper); color:var(--ink); }
  input::placeholder { color:#9a806a; }
  .button,.button-link { display:inline-flex; min-height:48px; align-items:center; justify-content:center; border:1px solid transparent; border-radius:4px; padding:10px 16px; cursor:pointer; font-weight:750; line-height:1.2; text-align:center; text-decoration:none; }
  .button:active,.button-link:active { transform:scale(.98); }
  .primary { background:var(--orange); color:white; }
  .primary:hover { background:var(--orange-dark); }
  .secondary { border-color:var(--line); background:var(--paper); color:var(--espresso); }
  .danger { border-color:#d5aaa5; background:#fff8f7; color:var(--danger); }
  .plain { border-color:transparent; background:transparent; color:var(--muted); }
  .actions { display:flex; flex-wrap:wrap; gap:10px; }
  .status { min-height:22px; margin:0; color:var(--muted); font-size:14px; line-height:1.45; }
  .status[data-tone="error"] { color:var(--danger); }
  .status[data-tone="success"] { color:#3e6427; }
  .notice { margin:0; border-left:4px solid var(--line); padding:12px 14px; background:var(--paper); color:var(--muted); line-height:1.45; }
  .songs { display:grid; gap:12px; margin:0; padding:0; list-style:none; counter-reset:song; }
  .song { display:grid; grid-template-columns:34px 56px minmax(0,1fr); gap:12px; align-items:center; border-top:1px solid var(--line); padding:14px 0 2px; counter-increment:song; }
  .song::before { content:counter(song); color:#9a806a; font-size:13px; font-variant-numeric:tabular-nums; text-align:center; }
  .art { width:56px; height:56px; border-radius:3px; background:#ead8c7; object-fit:cover; }
  .song-main { min-width:0; }
  .song-title,.song-artist { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .song-title { color:var(--espresso); font-weight:750; }
  .song-artist { margin-top:3px; color:var(--muted); font-size:13px; }
  .song-actions { grid-column:2 / -1; display:flex; flex-wrap:wrap; gap:8px; padding-bottom:12px; }
  .song-actions .button,.song-actions .button-link { min-height:48px; padding-inline:13px; font-size:14px; }
  .empty { padding:26px 0; color:var(--muted); text-align:center; }
  .link-output { overflow-wrap:anywhere; border:1px solid var(--line); border-radius:4px; padding:12px; background:var(--paper); color:var(--espresso); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .warning { color:var(--danger); font-size:13px; line-height:1.45; }
  [hidden] { display:none!important; }
  @media (max-width:520px) { .shell{padding-inline:16px}.topbar{margin-bottom:24px}.actions>.button,.actions>.button-link{width:100%}.song{grid-template-columns:28px 52px minmax(0,1fr)}.art{width:52px;height:52px} }
  @media (prefers-color-scheme:dark) { body{background:#1d1007;color:var(--cream)}.brand,h1,h2,label,.song-title{color:var(--cream)}.lede,.status,.song-artist,.notice{color:#d1ad8d}.panel,.song{border-color:#614326}.state,.notice,.secondary,.link-output,input{border-color:#614326;background:var(--espresso);color:var(--cream)}.private{background:#3b210c;color:#ffd0a6}.danger{border-color:#7e3831;background:#331311;color:#ffaaa3} }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.01ms!important; animation-duration:.01ms!important; animation-iteration-count:1!important; } }
`;

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
function setStatus(message,tone="info"){pageStatus.textContent=message;pageStatus.dataset.tone=tone;}
function reportCopy(copied,successMessage,failureMessage){setStatus(copied?successMessage:failureMessage,copied?"success":"error");}
async function copyText(value){
  if(navigator.clipboard){const copied=await navigator.clipboard.writeText(value).then(()=>true,()=>false);if(copied)return true;}
  const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();const copied=document.execCommand("copy");area.remove();return copied;
}
function showCreated(data){
  createdPublicUrl=typeof data.publicUrl==="string"?data.publicUrl:"";
  privateManagementUrl=typeof data.managementUrl==="string"?data.managementUrl:"";
  if(!createdPublicUrl||!privateManagementUrl){setStatus("The Thread was created, but its links could not be shown. Reload and try again.","error");return;}
  document.getElementById("created-public-url").textContent=createdPublicUrl;
  const openManagement=document.getElementById("open-management-view");openManagement.href=privateManagementUrl;openManagement.hidden=false;
  createView.hidden=true;successView.hidden=false;setStatus("Thread created.","success");document.getElementById("share-created-thread").focus();
}
createForm.addEventListener("submit",async(event)=>{
  event.preventDefault();const title=titleInput.value.trim();
  if(!title){setStatus("Enter a Thread title.","error");titleInput.focus();return;}
  createSubmit.disabled=true;createSubmit.textContent="Creating…";setStatus("Creating your Thread…");
  try{
    const response=await fetch(createForm.action,{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"create-thread"},body:JSON.stringify({title})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){setStatus(typeof data.error==="string"?data.error:"Couldn’t create this Thread. Try again.","error");return;}
    showCreated(data);
  }catch{setStatus("Couldn’t create this Thread. Check your connection and try again.","error");}
  finally{createSubmit.disabled=false;createSubmit.textContent="Create Thread";}
});
document.getElementById("copy-created-thread").addEventListener("click",async()=>{reportCopy(await copyText(createdPublicUrl),"Public Thread link copied.","Select and copy the public link above.");});
document.getElementById("share-created-thread").addEventListener("click",async()=>{
  if(navigator.share){try{await navigator.share({title:titleInput.value.trim(),url:createdPublicUrl});return;}catch(error){if(error&&error.name==="AbortError")return;}}
  reportCopy(await copyText(createdPublicUrl),"Public Thread link copied.","Select and copy the public link above.");
});
document.getElementById("save-management-link").addEventListener("click",async()=>{reportCopy(await copyText(privateManagementUrl),"Private management link copied. Save it somewhere safe.","Couldn’t copy the private link. Use the private link below before opening it.");});
</script></body></html>`;
}

function songRow(song: ThreadSongView, managed: boolean): string {
  const artwork = song.artworkUrl ? safeUrl(song.artworkUrl) : null;
  const canonicalUrl = safeUrl(song.canonicalUrl);
  const remove =
    managed && song.removeAction
      ? `<button class="button danger" type="button" data-remove-action="${safeUrl(song.removeAction)}" aria-label="Remove ${esc(song.title)}">Remove</button>`
      : "";
  return `<li class="song" data-contribution-id="${esc(song.contributionId)}">
    ${artwork && artwork !== "#" ? `<img class="art" src="${artwork}" alt="">` : `<div class="art" aria-hidden="true"></div>`}
    <div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-artist">${esc(song.artist)}</div></div>
    <div class="song-actions"><a class="button-link secondary" href="${canonicalUrl}">Open in my provider</a><button class="button plain" type="button" data-copy-song="${canonicalUrl}">Copy song link</button>${remove}</div>
  </li>`;
}

function addSection(model: ThreadPageModel): string {
  if (model.state === "closed") {
    return `<section class="panel"><h2>Contributions are closed</h2><p class="notice">This Thread is still available to listen to and share. This cannot be reopened.</p></section>`;
  }
  if (model.state === "full") {
    const guidance = model.managed
      ? "Remove a song to make room. Closing the Thread will keep its current songs."
      : "This Thread is full. The creator can remove a song to make room.";
    return `<section class="panel"><h2>This Thread is full</h2><p class="notice">${guidance}</p></section>`;
  }
  return `<section class="panel"><h2>${model.songs.length ? "Add a song" : "Add the first song"}</h2>
    <form class="form" id="add-song-form" action="${safeUrl(model.actions.add)}" method="post" novalidate>
      <label for="song-url">Spotify or Apple Music song link</label>
      <input id="song-url" name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(model.addValue ?? "")}" placeholder="https://open.spotify.com/track/…" aria-describedby="page-status">
      <button class="button primary" id="add-song-submit" type="submit">Add song</button>
    </form>
  </section>`;
}

export function threadPage(model: ThreadPageModel): string {
  const stateLabel = model.state === "closed" ? "Closed" : model.state === "full" ? "Full" : "Open";
  const description = `${model.songs.length} ${model.songs.length === 1 ? "song" : "songs"} in this listen.cx Thread.`;
  const firstArtwork = model.songs.find((song) => song.artworkUrl)?.artworkUrl;
  const closeAction = model.managed && model.state !== "closed" && model.actions.close ? safeUrl(model.actions.close) : null;
  return `<!doctype html><html lang="en"><head>${documentHead(`${model.title} — listen.cx`, description, firstArtwork)}</head><body data-thread-state="${model.state}" data-managed="${model.managed ? "true" : "false"}" data-activation-action="${safeUrl(model.actions.activateManagement)}">
<div class="shell"><header class="topbar"><a class="brand" href="/">listen.cx</a><button class="button secondary" type="button" data-copy-thread data-public-url="${safeUrl(model.publicUrl)}">Copy Thread</button></header><main>
  <section><p class="eyebrow">Pass the aux</p><h1>${esc(model.title)}</h1><p class="lede">A shared playlist Thread, in the order songs were added.</p></section>
  <div><span class="state" data-state="${model.state}">${stateLabel}</span></div>
  ${model.managed ? `<p class="private"><strong>Private management view.</strong> Share only with the Copy Thread button, which always uses the public link.</p>` : ""}
  ${statusRegion(model.status)}
  ${addSection(model)}
  <section class="panel"><h2>Songs</h2>
    ${model.songs.length ? `<ol class="songs" aria-label="Songs in chronological order">${model.songs.map((song) => songRow(song, model.managed)).join("")}</ol>` : `<p class="empty">No songs yet. Add the first song to start the Thread.</p>`}
  </section>
  <section class="panel"><h2>Share this Thread</h2><div class="actions"><button class="button primary" type="button" data-share-thread data-public-url="${safeUrl(model.publicUrl)}">Share Thread</button><button class="button secondary" type="button" data-copy-thread data-public-url="${safeUrl(model.publicUrl)}">Copy Thread link</button></div></section>
  ${closeAction ? `<section class="panel"><h2>Stop contributions</h2><p class="notice">Closing is permanent. Songs stay openable and shareable, but nobody can add another song.</p><button class="button danger" type="button" data-close-action="${closeAction}">Close contributions</button></section>` : ""}
</main></div>
<script>
const pageStatus=document.getElementById("page-status");
const activationAction=document.body.dataset.activationAction||"";
function setStatus(message,tone="info"){pageStatus.textContent=message;pageStatus.dataset.tone=tone;}
function reportCopy(copied,successMessage,failureMessage){setStatus(copied?successMessage:failureMessage,copied?"success":"error");}
async function copyText(value){
  if(navigator.clipboard){const copied=await navigator.clipboard.writeText(value).then(()=>true,()=>false);if(copied)return true;}
  const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.append(area);area.select();const copied=document.execCommand("copy");area.remove();return copied;
}
async function activateManagement(){
  if(!location.hash.startsWith("#manage="))return;
  const cleanUrl=location.pathname+location.search;
  let token="";
  try{token=decodeURIComponent(location.hash.slice("#manage=".length));}
  catch{history.replaceState(null,"",cleanUrl);setStatus("That private management link is invalid or no longer available.","error");return;}
  let response;
  try{response=await fetch(activationAction,{method:"POST",headers:{"Content-Type":"application/json","x-listen-management-action":"1"},body:JSON.stringify({token})});}
  catch{history.replaceState(null,"",cleanUrl);setStatus("That private management link could not be checked. Try opening it again.","error");return;}
  history.replaceState(null,"",cleanUrl);
  if(response.ok){location.reload();return;}
  setStatus("That private management link is invalid or no longer available.","error");
}
for(const button of document.querySelectorAll("[data-copy-song]")){button.addEventListener("click",async()=>{reportCopy(await copyText(button.dataset.copySong||""),"Song link copied.","Couldn’t copy the song link.");});}
for(const button of document.querySelectorAll("[data-copy-thread]")){button.addEventListener("click",async()=>{reportCopy(await copyText(button.dataset.publicUrl||""),"Public Thread link copied.","Couldn’t copy the Thread link.");});}
for(const button of document.querySelectorAll("[data-share-thread]")){button.addEventListener("click",async()=>{const url=button.dataset.publicUrl||"";if(navigator.share){try{await navigator.share({title:document.title,url});return;}catch(error){if(error&&error.name==="AbortError")return;}}reportCopy(await copyText(url),"Public Thread link copied.","Couldn’t share the Thread link.");});}
const addForm=document.getElementById("add-song-form");
if(addForm){
  const input=document.getElementById("song-url");const submit=document.getElementById("add-song-submit");let requestKey="";
  input.addEventListener("input",()=>{requestKey="";});
  addForm.addEventListener("submit",async(event)=>{
    event.preventDefault();const url=input.value.trim();if(!url){setStatus("Paste a Spotify or Apple Music song link.","error");input.focus();return;}
    requestKey=requestKey||(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random());submit.disabled=true;submit.textContent="Adding…";setStatus("Finding that song…");
    try{const response=await fetch(addForm.action,{method:"POST",headers:{"Content-Type":"application/json","X-Listen-Action":"add-song"},body:JSON.stringify({url,requestKey})});const data=await response.json().catch(()=>({}));if(response.ok){location.reload();return;}setStatus(typeof data.error==="string"?data.error:"Couldn’t add that song. Try again.","error");}
    catch{setStatus("Couldn’t add that song. Check your connection and try again.","error");}
    finally{submit.disabled=false;submit.textContent="Add song";}
  });
}
for(const button of document.querySelectorAll("[data-remove-action]")){button.addEventListener("click",async()=>{button.disabled=true;try{const response=await fetch(button.dataset.removeAction||"",{method:"POST",headers:{"x-listen-management-action":"1"}});if(response.ok){location.reload();return;}const data=await response.json().catch(()=>({}));setStatus(typeof data.error==="string"?data.error:"Couldn’t remove that song.","error");}catch{setStatus("Couldn’t remove that song. Try again.","error");}finally{button.disabled=false;}});}
const closeButton=document.querySelector("[data-close-action]");
if(closeButton){closeButton.addEventListener("click",async()=>{if(!confirm("Close contributions permanently? This Thread cannot be reopened."))return;closeButton.disabled=true;try{const response=await fetch(closeButton.dataset.closeAction||"",{method:"POST",headers:{"x-listen-management-action":"1"}});if(response.ok){location.reload();return;}const data=await response.json().catch(()=>({}));setStatus(typeof data.error==="string"?data.error:"Couldn’t close this Thread.","error");}catch{setStatus("Couldn’t close this Thread. Try again.","error");}finally{closeButton.disabled=false;}});}
activateManagement();
</script></body></html>`;
}
