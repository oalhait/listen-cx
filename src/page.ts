import type { LinkRow } from "./db.js";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function waveEnvelope(position: number): number {
  const beat = Math.abs(Math.sin(Math.PI * 7 * position));
  const swell = 0.55 + 0.45 * Math.sin(6 * Math.PI * position + 1.3);
  const jitter = 0.8 + 0.2 * Math.sin(46 * Math.PI * position);
  return Math.min(1, Math.max(0.06, (0.1 + 0.9 * beat * swell) * jitter));
}

function wavePath(width: number, height: number, cycles: number): string {
  const middle = height / 2;
  const step = width / cycles;
  let path = `M0 ${middle}`;
  for (let index = 0; index < cycles; index += 1) {
    const amplitude = waveEnvelope((index % cycles) / cycles) * (height / 2 - 1.25);
    const direction = index % 2 ? 1 : -1;
    path += ` Q${((index + 0.5) * step).toFixed(1)} ${(middle + direction * amplitude).toFixed(1)} ${((index + 1) * step).toFixed(1)} ${middle}`;
  }
  return path;
}

function waveform(): string {
  const width = 440;
  const height = 54;
  const path = wavePath(width * 2, height, 96);
  return `<div class="wave" aria-hidden="true"><svg viewBox="0 0 ${width * 2} ${height}"><path d="${path}"/></svg></div>`;
}

const RECEIVER_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=DM+Sans:wght@400;600&display=swap');
  :root { color-scheme: light dark; --ink:#211710; --muted:#7a6a5c; --cream:#fffdfa; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { min-height:100vh; display:grid; place-items:center; padding:24px 20px; background:#f4f0e9; color:var(--ink); font-family:"DM Sans",sans-serif; }
  .receiver { width:100%; max-width:360px; text-align:center; }
  .art { width:208px; height:208px; display:block; object-fit:cover; margin:0 auto 24px; border-radius:4px; background:#e9dfd4; box-shadow:0 4px 12px rgba(33,23,16,.12),0 16px 40px rgba(33,23,16,.14); }
  h1 { margin:0; font:700 24px/1.15 "Bricolage Grotesque",sans-serif; letter-spacing:-.02em; }
  .artist { margin:6px 0 0; color:var(--muted); font-size:15px; }
  .question { margin:30px 0 12px; color:var(--muted); font-size:13px; font-weight:600; }
  .provider { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; min-height:52px; margin:0 0 10px; border:1px solid #d8cdc1; border-radius:4px; background:var(--cream); color:var(--ink); text-decoration:none; font-weight:600; transition:background 150ms ease,transform 150ms cubic-bezier(.34,1.56,.64,1); }
  .provider:hover { background:#fbf0e4; }
  .provider:active { transform:scale(.97); }
  .provider:focus-visible { outline:3px solid #ff9840; outline-offset:2px; }
  .provider svg { width:20px; height:20px; fill:currentColor; }
  .foot { margin:18px 0 0; color:var(--muted); font-size:12px; line-height:1.4; }
  @media (prefers-color-scheme:dark) { body{background:#1b0e03;color:#fff3e8}.provider{background:#2b1706;border-color:#4b321d;color:#fff3e8}.provider:hover{background:#3e2109}.artist,.question,.foot{color:#c7ae97} }
`;

const SPOTIFY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.6 14.4a.6.6 0 0 1-.86.2c-2.35-1.44-5.3-1.76-8.79-.97a.63.63 0 0 1-.28-1.22c3.81-.87 7.08-.5 9.72 1.12.3.19.4.57.2.87zm1.22-2.73a.78.78 0 0 1-1.07.26c-2.69-1.66-6.8-2.14-9.98-1.17a.78.78 0 1 1-.45-1.5c3.63-1.1 8.15-.57 11.24 1.34.37.22.48.7.26 1.07zm.11-2.85C14.7 8.9 9.4 8.73 6.32 9.66a.94.94 0 1 1-.54-1.79c3.53-1.07 9.4-.86 13.1 1.34a.94.94 0 0 1-.95 1.61z"/></svg>`;
const APPLE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.36 12.76c-.02-2.07 1.7-3.06 1.77-3.11-.96-1.41-2.46-1.6-3-1.62-1.28-.13-2.5.75-3.14.75-.65 0-1.65-.73-2.71-.71-1.4.02-2.68.81-3.4 2.06-1.45 2.51-.37 6.24 1.04 8.28.69 1 1.51 2.12 2.59 2.08 1.04-.04 1.43-.67 2.69-.67 1.25 0 1.61.67 2.71.65 1.12-.02 1.83-1.02 2.51-2.02.79-1.16 1.12-2.28 1.14-2.34-.03-.01-2.18-.84-2.2-3.35zM14.3 6.67c.57-.7.96-1.66.85-2.63-.83.03-1.83.55-2.42 1.24-.53.62-1 1.6-.87 2.55.92.07 1.86-.47 2.44-1.16z"/></svg>`;

function providerButtons(row: LinkRow): string {
  const buttons = [
    `<a class="provider" href="?to=spotify">${SPOTIFY_ICON}${esc(row.spotify_url ? "Spotify" : "Find on Spotify")}</a>`,
    `<a class="provider" href="?to=apple">${APPLE_ICON}${esc(row.apple_url ? "Apple Music" : "Find on Apple Music")}</a>`,
  ];
  if (Math.random() < 0.5) buttons.reverse();
  return buttons.join("");
}

export function choicePage(row: LinkRow, baseUrl: string): string {
  const canonical = `${baseUrl}/${row.slug}`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(row.title)} — ${esc(row.artist)}</title>
<meta property="og:title" content="${esc(row.title)}"><meta property="og:description" content="${esc(row.artist)}">
${row.artwork_url ? `<meta property="og:image" content="${esc(row.artwork_url)}">` : ""}
<meta property="og:url" content="${esc(canonical)}"><meta name="twitter:card" content="summary_large_image">
<style>${RECEIVER_STYLES}</style></head><body><main class="receiver">
${row.artwork_url ? `<img class="art" src="${esc(row.artwork_url)}" alt="">` : `<div class="art"></div>`}
<h1>${esc(row.title)}</h1><p class="artist">${esc(row.artist)}</p>
<p class="question">Where do you listen?</p>${providerButtons(row)}
<p class="foot">Remembers your choice. Next time, songs open instantly.</p>
</main></body></html>`;
}

const CREATOR_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700;800&family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap');
  :root { color-scheme:dark; --orange:#ff7a00; --orange-dark:#e56d00; --espresso:#2b1706; --sunken:#3e2109; --cream:#fff3e8; --muted:#e0bc97; --focus:#ff9840; }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; }
  body { min-height:100vh; background:var(--orange); color:white; font-family:"DM Sans",sans-serif; -webkit-font-smoothing:antialiased; }
  button,input { font:inherit; }
  .shell { width:100%; max-width:480px; min-height:100vh; margin:0 auto; display:flex; flex-direction:column; padding:0 20px; overflow:hidden; }
  header { display:flex; align-items:center; min-height:76px; font:700 20px/1 "Bricolage Grotesque",sans-serif; letter-spacing:-.02em; }
  .main { flex:1; display:flex; align-items:center; padding:18px 0 32px; }
  .panel { width:100%; background:var(--espresso); border:1px solid rgba(255,243,232,.14); border-radius:6px; padding:28px 24px; box-shadow:0 4px 12px rgba(33,23,16,.12),0 16px 40px rgba(33,23,16,.14); }
  .eyebrow { margin:0 0 10px; color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
  h1 { margin:0; color:var(--cream); font:800 clamp(38px,10vw,52px)/1.02 "Bricolage Grotesque",sans-serif; letter-spacing:-.035em; }
  .lede { margin:15px 0 28px; color:var(--muted); font-size:16px; line-height:1.5; }
  form { display:grid; gap:12px; }
  label { color:var(--cream); font-size:13px; font-weight:600; }
  input { width:100%; min-height:56px; padding:0 15px; border:1px solid rgba(255,243,232,.22); border-radius:4px; outline:none; background:var(--sunken); color:var(--cream); font-family:"DM Mono",monospace; font-size:14px; transition:border 150ms ease,box-shadow 150ms ease; }
  input::placeholder { color:#a77f5a; opacity:1; }
  input:focus { border-color:var(--focus); box-shadow:0 0 0 3px rgba(255,152,64,.3); }
  .help { min-height:18px; margin:-2px 0 0; color:var(--muted); font-size:13px; line-height:1.4; }
  .help[data-state="error"] { color:#ffaaa3; }
  .primary,.secondary { min-height:52px; border:0; border-radius:4px; padding:0 18px; cursor:pointer; font-weight:700; transition:background 150ms ease,transform 150ms cubic-bezier(.34,1.56,.64,1),opacity 150ms ease; }
  .primary { margin-top:2px; background:var(--orange); color:white; box-shadow:0 6px 20px rgba(255,122,0,.24); }
  .primary:hover { background:var(--orange-dark); }
  .secondary { width:100%; background:var(--cream); color:#211710; }
  .primary:active,.secondary:active,.copy:active,.text-button:active { transform:scale(.97); }
  button:focus-visible,a:focus-visible { outline:3px solid var(--focus); outline-offset:2px; }
  button:disabled { cursor:wait; opacity:.55; }
  .wave { width:100%; height:54px; margin:4px 0 20px; overflow:hidden; flex:none; }
  .wave svg { width:200%; height:54px; display:block; animation:wave-flow 3.2s linear infinite; }
  .wave path { fill:none; stroke:white; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  @keyframes wave-flow { to { transform:translateX(-50%); } }
  .view[hidden] { display:none; }
  .song { display:flex; align-items:center; gap:14px; margin:24px 0 16px; padding:12px; border:1px solid rgba(255,243,232,.14); border-radius:4px; background:var(--sunken); }
  .song img,.art-placeholder { width:64px; height:64px; flex:none; border-radius:2px; object-fit:cover; background:var(--orange); }
  .song-copy { min-width:0; }
  .song-title { overflow:hidden; color:var(--cream); font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
  .song-artist { overflow:hidden; margin-top:3px; color:var(--muted); font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
  .link-field { display:flex; align-items:center; gap:8px; padding:6px 6px 6px 15px; border-radius:4px; background:var(--sunken); }
  .share-link { min-width:0; flex:1; overflow:hidden; color:var(--cream); font:500 14px/1.4 "DM Mono",monospace; text-overflow:ellipsis; white-space:nowrap; }
  .copy { min-height:40px; padding:0 16px; border:0; border-radius:4px; background:var(--orange); color:white; cursor:pointer; font-weight:700; }
  .actions { display:grid; gap:10px; margin-top:18px; }
  .text-button { min-height:48px; border:0; background:transparent; color:var(--muted); cursor:pointer; font-weight:600; }
  @media (max-width:520px) { .main{align-items:flex-start;padding-top:10vh}.panel{padding:24px 20px} }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important} }
`;

export function homePage(_baseUrl: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Share a song — listen.cx</title><style>${CREATOR_STYLES}</style></head><body>
<div class="shell"><header>listen.cx</header><main class="main">
  <section class="panel view" id="create-view">
    <p class="eyebrow">One link. Every player.</p><h1>Paste a song</h1>
    <p class="lede">Drop in a Spotify or Apple Music track. We’ll make a link that works for either listener.</p>
    <form id="create-form" novalidate>
      <label for="url">Song link</label>
      <input id="url" type="url" placeholder="https://open.spotify.com/track/…" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="input-help" autofocus>
      <p id="input-help" class="help" role="status" aria-live="polite">Spotify and Apple Music track links work.</p>
      <button class="primary" id="go" type="submit">Make my link</button>
    </form>
  </section>
  <section class="panel view" id="success-view" hidden>
    <p class="eyebrow">Ready to send</p><h1>Your link is ready</h1>
    <div class="song"><div class="art-placeholder" id="art-placeholder"></div><img id="song-art" alt="" hidden><div class="song-copy"><div class="song-title" id="song-title"></div><div class="song-artist" id="song-artist"></div></div></div>
    <div class="link-field"><span class="share-link" id="share-link"></span><button class="copy" id="copy" type="button">Copy</button></div>
    <div class="actions"><a class="secondary" id="preview" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Preview their link</a><button class="text-button" id="again" type="button">Share another song</button></div>
  </section>
</main>${waveform()}</div>
<script>
const createView=document.getElementById("create-view");
const successView=document.getElementById("success-view");
const form=document.getElementById("create-form");
const input=document.getElementById("url");
const help=document.getElementById("input-help");
const submit=document.getElementById("go");
const copyButton=document.getElementById("copy");
let createdLink="";
function message(text,state=""){help.textContent=text;help.dataset.state=state;}
function reset(){successView.hidden=true;createView.hidden=false;form.reset();message("Spotify and Apple Music track links work.");submit.disabled=false;submit.textContent="Make my link";input.focus();}
function showSuccess(data){
  createdLink=data.link;
  document.getElementById("song-title").textContent=data.title;
  document.getElementById("song-artist").textContent=data.artist;
  const art=document.getElementById("song-art");
  art.hidden=!data.artworkUrl;
  document.getElementById("art-placeholder").hidden=Boolean(data.artworkUrl);
  if(data.artworkUrl) art.src=data.artworkUrl;
  document.getElementById("share-link").textContent=data.link.replace(/^https?:\\/\\//,"");
  document.getElementById("preview").href=data.link+"?choose=1";
  createView.hidden=true;successView.hidden=false;
  copyButton.textContent="Copy";
}
input.addEventListener("input",()=>{if(help.dataset.state==="error")message("Spotify and Apple Music track links work.");});
form.addEventListener("submit",async(event)=>{
  event.preventDefault();
  const url=input.value.trim();
  if(!url){message("Paste a Spotify or Apple Music song link first.","error");input.focus();return;}
  submit.disabled=true;submit.textContent="Finding the song…";message("Matching it across players…");
  try{
    const response=await fetch("/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
    const data=await response.json();
    if(!response.ok){message(data.error||"Couldn’t resolve that link.","error");return;}
    showSuccess(data);
  }catch{message("Something went wrong. Try again.","error");}
  finally{submit.disabled=false;submit.textContent="Make my link";}
});
copyButton.addEventListener("click",async()=>{
  const copied=await navigator.clipboard.writeText(createdLink).then(()=>true,()=>false);
  copyButton.textContent=copied?"Copied":"Select link";
  if(!copied){const selection=getSelection();const range=document.createRange();range.selectNodeContents(document.getElementById("share-link"));selection.removeAllRanges();selection.addRange(range);}
});
document.getElementById("again").addEventListener("click",reset);
</script></body></html>`;
}
