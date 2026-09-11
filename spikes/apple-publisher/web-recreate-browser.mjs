import { createRevision, readPlaylist } from './web-recreate.mjs';

const status = document.querySelector('#status');
const buttons = [...document.querySelectorAll('button')];
let music;
let state;
const show = value => { status.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
async function local(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!response.ok) throw new Error(`Local operation ${path} refused (${response.status})`);
  return response.json();
}
async function request(path, options = {}) {
  const result = await music.api.music(path, {}, { fetchOptions: { method: options.method ?? 'GET', ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) } });
  return result.data;
}
async function refresh() {
  state = await local('/state');
  document.querySelector('#authorize').disabled = false;
  document.querySelector('#first').disabled = !music.isAuthorized || state.revisions.length > 0;
  document.querySelector('#second').disabled = !music.isAuthorized || state.revisions.length !== 1 || !state.revisions[0].id;
  document.querySelector('#read').disabled = !music.isAuthorized || !state.revisions.some(item => item.id);
}
async function read(revision) {
  const item = state.revisions.find(item => item.revision === revision);
  if (!item?.id) throw new Error('No known playlist ID; creation must not be retried');
  const result = await readPlaylist(request, item.id, state.fixtures[revision - 1]);
  await local('/readback', result);
  return result;
}
async function preflight() {
  const storefront = (await request('/v1/me/storefront')).data?.[0]?.id;
  if (!/^[a-z]{2}$/.test(storefront ?? '')) throw new Error('Subscriber storefront unavailable');
  const ids = [...new Set(state.fixtures.flat())];
  const result = await request(`/v1/catalog/${storefront}/songs?ids=${ids.join(',')}`);
  if (ids.some(id => !result.data?.some(song => song.id === id && song.attributes?.playParams))) throw new Error('Not all four fixture songs are playable in this storefront');
  return storefront;
}
async function publish(revision) {
  await preflight();
  if (revision === 2 && !(await read(1)).matches) throw new Error('Revision 1 does not match actual readback');
  await local('/reserve', { revision });
  const id = await createRevision(request, state.runID, revision, state.fixtures[revision - 1]);
  await local('/created', { revision, id });
  state = await local('/state');
  let result;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { result = await read(revision); } catch { result = { id, matches: false, waitingForReadback: true }; }
    show(result);
    if (result.matches) break;
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (revision === 2) show({ revision2: result, revision1AfterRecreation: await read(1) });
}
function action(selector, callback, failureMessage = 'The operation did not complete. Read the saved state before continuing. An uncertain creation is fenced against retries.') {
  document.querySelector(selector).onclick = async () => {
    buttons.forEach(button => { button.disabled = true; });
    try { await callback(); }
    catch { show(failureMessage); }
    finally { await refresh(); }
  };
}
action('#authorize', async () => { await music.authorize(); show('Apple Music authorized. Ready to create the first disposable revision.'); }, 'Apple Music authorization did not complete. Choose Authorize Apple Music to reopen Apple’s sign-in and consent. No creation was attempted by this authorization step.');
action('#first', () => publish(1));
action('#second', () => publish(2));
action('#read', async () => { show(await Promise.all(state.revisions.filter(item => item.id).map(item => read(item.revision)))); });
document.addEventListener('musickitloaded', async () => {
  try {
    const { developerToken } = await local('/developer-token');
    await MusicKit.configure({ developerToken, app: { name: 'listen.cx disposable web spike', build: '1' } });
    music = MusicKit.getInstance();
    await refresh();
    show({ message: 'Ready for Apple Music authorization.', runID: state.runID, revisions: state.revisions });
  } catch { show('MusicKit initialization failed. No playlist was created.'); }
});
const script = document.createElement('script');
script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
document.head.append(script);
