import { createLinkController } from './create-link.js';

const form = document.querySelector('#link-form');
const input = document.querySelector('#music-url');
const message = document.querySelector('#form-message');
const result = document.querySelector('#link-result');
const initialMessage = message.textContent;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let switchingView = false;

async function showGeneratorView(showPreview, status, prepare = () => {}) {
  if (switchingView) return;
  switchingView = true;
  const outgoing = showPreview ? form : result;
  const incoming = showPreview ? result : form;
  const shouldAnimate = !reducedMotion.matches && typeof incoming.animate === 'function';
  const content = (view) => view === form
    ? [input, form.querySelector('button')]
    : [result.querySelector('.result-track'), result.querySelector('.result-actions')];
  const animations = [];
  try {
    if (!outgoing.hidden && shouldAnimate) {
      const exits = content(outgoing).map((element) => element.animate([
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
        { opacity: 0, transform: 'translateY(-5px)', filter: 'blur(2px)' },
      ], { duration: 120, easing: 'ease-in', fill: 'forwards' }));
      animations.push(...exits);
      await Promise.all(exits.map((animation) => animation.finished.catch(() => {})));
    }
    prepare();
    outgoing.hidden = true;
    incoming.hidden = false;
    document.querySelector('#share').classList.toggle('has-result', showPreview);
    message.textContent = status;
    (showPreview ? document.querySelector('#reset-link') : input).focus({ preventScroll: true });
    if (shouldAnimate) {
      const entrances = content(incoming).map((element, index) => element.animate([
        { opacity: 0, transform: 'translateY(9px) scale(.98)', filter: 'blur(2px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0)' },
      ], { duration: 340, delay: index * 35, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'both' }));
      animations.push(...entrances);
      await Promise.all(entrances.map((animation) => animation.finished.catch(() => {})));
    }
  } finally {
    animations.forEach((animation) => animation.cancel());
    switchingView = false;
  }
}

const submitButton = form.querySelector('button');
const exampleButton = document.querySelector('#try-example');
const copyButton = document.querySelector('#copy-link');
const shortLink = document.querySelector('#short-link');
let loading = false;
let copyResetTimer;
function setCopyState(copied) {
  clearTimeout(copyResetTimer);
  const label = copied ? 'Copied' : 'Copy link';
  copyButton.setAttribute('aria-label', label);
  copyButton.title = label;
  copyButton.querySelector('use').setAttribute('href', copied ? '#check' : '#copy');
  copyButton.querySelector('.button-label').textContent = label;
  if (copied) copyResetTimer = setTimeout(() => setCopyState(false), 3000);
}

const controller = createLinkController({
  async update(state) {
    loading = state.status === 'loading';
    submitButton.disabled = loading;
    input.disabled = loading;
    exampleButton.disabled = loading;
    form.setAttribute('aria-busy', String(loading));
    submitButton.querySelector('span').textContent = loading ? 'Making link…' : 'Make a link';
    message.classList.toggle('is-error', state.status === 'error');
    input.removeAttribute('aria-invalid');
    if (state.status === 'loading') message.textContent = 'Finding your track…';
    if (state.status === 'error') {
      message.textContent = state.error;
      input.focus();
    }
    if (state.status === 'success') {
      const { data } = state;
      document.querySelector('#result-title').textContent = data.title;
      document.querySelector('#result-artist').textContent = data.artist;
      shortLink.hidden = true;
      shortLink.href = data.link;
      shortLink.textContent = data.link.replace(/^https?:\/\//, '');
      setCopyState(false);
      const artwork = document.querySelector('#result-artwork');
      artwork.hidden = !data.artworkUrl;
      if (data.artworkUrl) artwork.src = data.artworkUrl;
      else artwork.removeAttribute('src');
      await showGeneratorView(true, '');
    }
  },
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (switchingView || form.hidden) return;
  void controller.submit(input.value);
});

copyButton.addEventListener('click', async () => {
  copyButton.disabled = true;
  try {
    await navigator.clipboard.writeText(shortLink.href);
    setCopyState(true);
    message.textContent = '';
  } catch {
    shortLink.hidden = false;
    const range = document.createRange();
    range.selectNodeContents(shortLink);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    message.textContent = 'Could not copy automatically. Copy the selected link, or open it to share.';
  } finally {
    copyButton.disabled = false;
  }
});

input.addEventListener('input', () => {
  if (!loading && message.classList.contains('is-error')) {
    input.removeAttribute('aria-invalid');
    message.classList.remove('is-error');
    message.textContent = initialMessage;
  }
});

document.querySelector('#reset-link').addEventListener('click', () => {
  void showGeneratorView(false, initialMessage, () => { input.value = ''; });
});

document.querySelector('#try-example').addEventListener('click', async () => {
  if (switchingView || loading) return;
  const prepare = () => {
    input.value = 'https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO';
    input.removeAttribute('aria-invalid');
    message.classList.remove('is-error');
  };
  if (form.hidden) await showGeneratorView(false, '', prepare);
  else {
    prepare();
    message.textContent = '';
    input.focus({ preventScroll: true });
  }
  document.querySelector('#share').scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
});

document.querySelectorAll('[data-provider]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-provider]').forEach((choice) => {
      const selected = choice === button;
      choice.setAttribute('aria-pressed', String(selected));
      choice.querySelector('.choice-arrow use').setAttribute('href', selected ? '#check' : '#arrow');
    });
    document.querySelector('.receiver-card').classList.add('has-choice');
    document.querySelector('#preference-note').textContent = `${button.dataset.provider} preview. Shared links open the source track or search the other app.`;
  });
});
