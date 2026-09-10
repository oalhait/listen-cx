const form = document.querySelector('#link-form');
const input = document.querySelector('#music-url');
const message = document.querySelector('#form-message');
const result = document.querySelector('#link-result');
const initialMessage = message.textContent;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let switchingView = false;

// Keep the outer surface still; move only the content within it.
async function showGeneratorView(showPreview, status, prepare = () => {}) {
  if (switchingView) return;
  switchingView = true;
  const outgoing = showPreview ? form : result;
  const incoming = showPreview ? result : form;
  const shouldAnimate = !reducedMotion.matches && typeof incoming.animate === 'function';
  const content = (view) => view === form
    ? [input, form.querySelector('button')]
    : [result.querySelector('.preview-tag'), result.querySelector('strong'), result.querySelector('button')];
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

function isMusicLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.hostname === 'open.spotify.com') return /^\/(?:intl-[a-z]{2}\/)?(?:track|album)\/[A-Za-z0-9]+\/?$/.test(url.pathname);
    if (url.hostname === 'music.apple.com') return /^\/[a-z]{2}\/(?:album|song)\/.+/.test(url.pathname);
    if (url.hostname === 'spotify.link') return url.pathname.length > 1;
    return false;
  } catch {
    return false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isMusicLink(input.value.trim())) {
    message.textContent = input.value.trim() ? 'Try a Spotify or Apple Music song or album link.' : 'Paste a song or album link to try the preview.';
    message.classList.add('is-error');
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  message.classList.remove('is-error');
  void showGeneratorView(true, 'Preview only. Link generation is not connected yet.');
});

input.addEventListener('input', () => {
  if (input.hasAttribute('aria-invalid')) {
    input.removeAttribute('aria-invalid');
    message.classList.remove('is-error');
    message.textContent = initialMessage;
  }
});

document.querySelector('#reset-link').addEventListener('click', () => {
  void showGeneratorView(false, initialMessage, () => { input.value = ''; });
});

document.querySelector('#try-example').addEventListener('click', async () => {
  if (switchingView) return;
  const prepare = () => {
    input.value = 'https://music.apple.com/us/album/this-thing-of-ours/1562919023';
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
    document.querySelector('#preference-note').textContent = `${button.dataset.provider} selected`;
  });
});
