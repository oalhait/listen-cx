import { accountPage } from '../src/account-page.ts';
import { expect, it, vi } from 'vitest';
import { accountReturn, mountAccount, mountAccountProfile, createProfileActions, createAccountActions, prepareAccountAppleMusic, prepareBrowserAppleMusic, prepareSettingsAppleMusic, waitForAccountMusicKit } from './account.js';

function setup(overrides = {}) {
  const request = vi.fn().mockResolvedValue({});
  const navigate = vi.fn();
  const reload = vi.fn();
  const update = vi.fn();
  const music = { authorize: vi.fn().mockResolvedValue('private-token'), unauthorize: vi.fn().mockResolvedValue(undefined) };
  const actions = createAccountActions({ returnTo: 'a'.repeat(22), request, navigate, reload, update, getMusic: () => music, getAuthorizationBinding: () => 'session-binding', ...overrides });
  return { actions, request, navigate, reload, update, music };
}

it('accepts only Thread capabilities for the return link', () => {
  expect(accountReturn(`?thread=${'a'.repeat(22)}`)).toBe('a'.repeat(22));
  for (const value of ['', '?thread=https://evil.test', '?thread=../../x', '?thread=short']) expect(accountReturn(value)).toBeNull();
});

it('starts each provider with the Thread return context and validates its destination', async () => {
  for (const [provider, host] of [['spotify', 'accounts.spotify.com']]) {
    const { actions, request, navigate } = setup();
    request.mockResolvedValue({ url: `https://${host}/authorize?state=opaque` });
    await actions.signIn(provider);
    expect(request).toHaveBeenCalledWith(`/account/${provider}/start`, { returnTo: 'a'.repeat(22) });
    expect(navigate).toHaveBeenCalledWith(`https://${host}/authorize?state=opaque`);
  }
});

it('rejects hostile authorization links and unsupported providers without exposing raw errors', async () => {
  for (const url of ['javascript:alert(1)', 'https://accounts.spotify.com.evil.test', 'https://user:password@accounts.spotify.com', 'https://accounts.spotify.com:8443', 'https://appleid.apple.com']) {
    const { actions, request, navigate, update } = setup();
    request.mockResolvedValue({ url });
    await actions.signIn('spotify');
    expect(navigate).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
  }
  const { actions, request } = setup();
  await actions.signIn('unsupported');
  expect(request).not.toHaveBeenCalled();
});

it('authorizes Apple synchronously from the gesture and sends its token only in the POST body', async () => {
  const { actions, music, request, reload } = setup();
  const pending = actions.authorizeApple();
  expect(music.authorize).toHaveBeenCalledTimes(1);
  await pending;
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/authorize', { musicUserToken: 'private-token', authorizationBinding: 'session-binding' });
  expect(reload).toHaveBeenCalledTimes(1);
});

it('prepares MusicKit only with the account snapshot binding and preserves it for authorization', async () => {
  const music = { authorize: vi.fn() };
  const MusicKit = { configure: vi.fn(), getInstance: () => music };
  const request = vi.fn().mockResolvedValue({ developerToken: 'developer-token', authorizationBinding: 'session-binding' });
  expect(await prepareAccountAppleMusic('session-binding', request, MusicKit)).toEqual({ music, authorizationBinding: 'session-binding' });
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/token', { authorizationBinding: 'session-binding' });
  expect(music.authorize).not.toHaveBeenCalled();
});

it('rejects missing or changed preparation bindings before configuring MusicKit', async () => {
  const MusicKit = { configure: vi.fn(), getInstance: vi.fn() };
  const request = vi.fn().mockResolvedValue({ developerToken: 'developer-token', authorizationBinding: 'different-session' });
  await expect(prepareAccountAppleMusic(null, request, MusicKit)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  await expect(prepareAccountAppleMusic('session-binding', request, MusicKit)).rejects.toThrow();
  request.mockResolvedValue({ developerToken: 'developer-token' });
  await expect(prepareAccountAppleMusic('session-binding', request, MusicKit)).rejects.toThrow();
  expect(MusicKit.configure).not.toHaveBeenCalled();
});

it('does not authorize or submit an Apple grant without a prepared session binding', async () => {
  const { actions, music, request } = setup({ getAuthorizationBinding: () => null });
  await actions.authorizeApple();
  expect(music.authorize).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('captures the prepared binding before the asynchronous Apple grant completes', async () => {
  let binding = 'original-session';
  const { actions, music, request } = setup({ getAuthorizationBinding: () => binding });
  let finish;
  music.authorize.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = actions.authorizeApple();
  binding = 'replacement-session';
  finish('private-token');
  await pending;
  expect(request).toHaveBeenCalledWith('/account/apple/authorize', { musicUserToken: 'private-token', authorizationBinding: 'original-session' });
});

it('keeps failed Apple authorization private and permits retry', async () => {
  const { actions, music, request, update } = setup();
  music.authorize.mockRejectedValueOnce(new Error('private-token'));
  await actions.authorizeApple();
  expect(request).not.toHaveBeenCalled();
  expect(JSON.stringify(update.mock.calls)).not.toContain('private-token');
  await actions.authorizeApple();
  expect(request).toHaveBeenCalledTimes(1);
});

it('deduplicates sign-out requests and clears MusicKit before reloading', async () => {
  const { actions, request, reload, music } = setup();
  let finish;
  request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = actions.signOut();
  await actions.signOut();
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/sign-out', {});
  expect(reload).not.toHaveBeenCalled();
  finish({});
  await pending;
  expect(music.unauthorize).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('still signs out and resets the page when cached MusicKit cleanup fails', async () => {
  const { actions, request, reload, music } = setup();
  music.unauthorize.mockRejectedValue(new Error('SDK failed'));
  await actions.signOut();
  expect(request).toHaveBeenCalledWith('/account/sign-out', {});
  expect(reload).toHaveBeenCalledTimes(1);
  const uninitialized = setup({ getMusic: () => { throw new Error('MusicKit not initialized'); } });
  await uninitialized.actions.signOut();
  expect(uninitialized.reload).toHaveBeenCalledTimes(1);
});

it('reports an unavailable MusicKit script after a bounded wait', async () => {
  vi.useFakeTimers();
  const document = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const pending = expect(waitForAccountMusicKit({}, document)).rejects.toThrow('Apple Music unavailable');
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  expect(document.removeEventListener).toHaveBeenCalledWith('musickitloaded', expect.any(Function));
  vi.useRealTimers();
});

it('uses MusicKit directly for Apple onboarding without calling Sign in with Apple', async () => {
  const { actions, request, music, navigate } = setup();
  const pending = actions.signIn('apple');
  expect(music.authorize).toHaveBeenCalledTimes(1);
  await pending;
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/authorize', { musicUserToken: 'private-token', authorizationBinding: 'session-binding' });
  expect(navigate).not.toHaveBeenCalled();
});

it('prepares anonymous Apple Music with a browser binding before the user gesture', async () => {
  const music = {};
  const MusicKit = { configure: vi.fn().mockResolvedValue(undefined), getInstance: () => music };
  const request = vi.fn().mockResolvedValue({ developerToken: 'app-jwt', authorizationBinding: 'browser-grant' });
  expect(await prepareBrowserAppleMusic(request, MusicKit)).toEqual({ music, authorizationBinding: 'browser-grant' });
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/prepare', {});
  expect(MusicKit.configure).toHaveBeenCalledWith(expect.objectContaining({ developerToken: 'app-jwt' }));
  await expect(prepareBrowserAppleMusic(async () => ({ developerToken: 'app-jwt' }), MusicKit)).rejects.toThrow('Browser preparation expired');
});


it('prepares Apple Music against the signed-in account even when Spotify is the first connection', async () => {
  const MusicKit = { configure: vi.fn(), getInstance: () => ({}) };
  const request = vi.fn().mockResolvedValue({ developerToken: 'developer-token', authorizationBinding: 'group-session' });
  await prepareSettingsAppleMusic({ account: { provider: 'spotify' }, authorizationBinding: 'group-session' }, request, MusicKit);
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/token', { authorizationBinding: 'group-session' });
});

it('prepares a browser account only when signed out', async () => {
  const MusicKit = { configure: vi.fn(), getInstance: () => ({}) };
  const request = vi.fn().mockResolvedValue({ developerToken: 'developer-token', authorizationBinding: 'browser-session' });
  await prepareSettingsAppleMusic({ account: null, authorizationBinding: null }, request, MusicKit);
  expect(request).toHaveBeenCalledExactlyOnceWith('/account/apple/prepare', {});
});


it('renders both provider connection cards and one sign-out control', () => {
  const page = accountPage();
  expect(page).toContain('data-account-provider="apple"');
  expect(page).toContain('data-account-provider="spotify"');
  expect(page.match(/id="account-sign-out"/g)).toHaveLength(1);
  expect(page).not.toContain('Choose one music provider');
});

it.each([false, true])('keeps Apple authorization available alongside Spotify (Apple linked: %s)', async appleLinked => {
  const element = () => ({ dataset: {}, children: [], events: {}, selectors: {}, textContent: '',
    setAttribute: vi.fn(), after: vi.fn(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this.events[name] = handler; },
    querySelector(selector) { return this.selectors[selector]; },
  });
  const root = element();
  for (const id of ['account-message', 'apple-readiness', 'account-return', 'account-settings', 'account-sign-out', 'account-subscriptions']) root.selectors[`#${id}`] = element();
  const buttons = ['apple', 'spotify'].map(provider => {
    const card = element();
    card.selectors['[data-account-label]'] = element();
    card.selectors['[data-account-status]'] = element();
    root.selectors[`[data-account-provider="${provider}"]`] = card;
    const button = element();
    button.dataset.signIn = provider;
    return button;
  });
  root.querySelectorAll = () => buttons;
  const spotify = { provider: 'spotify', connected: true, label: 'Spotify listener' };
  const apple = { provider: 'apple', connected: true, label: 'Apple listener' };
  const connections = appleLinked ? [spotify, apple] : [spotify];
  const data = { account: spotify, connections, available: { apple: true, spotify: true }, authorizationBinding: 'group-session',
    subscriptions: connections.map(account => ({ provider: account.provider, capability: 'a'.repeat(22), title: 'Road trip', connected: true, status: 'pending' })) };
  const music = { authorize: vi.fn().mockResolvedValue('music-user-token') };
  const fetcher = vi.fn(async path => ({ ok: true, json: async () => path === '/api/account' ? data
    : { developerToken: 'developer-token', authorizationBinding: 'group-session' } }));
  vi.stubGlobal('document', { createElement: element });
  vi.stubGlobal('window', { location: { search: '', reload: vi.fn() }, MusicKit: { configure: vi.fn(), getInstance: () => music } });
  vi.stubGlobal('fetch', fetcher);
  try {
    await mountAccount(root);
    await vi.waitFor(() => expect(buttons[0].disabled).toBe(false));
    expect(buttons[0].textContent).toBe(`${appleLinked ? 'Reconnect' : 'Connect'} Apple Music ↗`);
    expect(buttons[1].textContent).toBe('Reconnect Spotify ↗');
    expect(root.selectors['[data-account-provider="spotify"]'].selectors['[data-account-status]'].textContent).toBe('Connected');
    const titles = root.selectors['#account-subscriptions'].children.map(item => item.children[0].textContent);
    expect(titles).toContain('Road trip · Spotify');
    if (appleLinked) expect(titles).toContain('Road trip · Apple Music');
    expect(fetcher).toHaveBeenCalledWith('/account/apple/token', expect.objectContaining({ body: JSON.stringify({ authorizationBinding: 'group-session' }) }));
    buttons[0].events.click();
    expect(music.authorize).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(1));
  } finally { vi.unstubAllGlobals(); }
});


it('keeps the profile form hidden until a signed-in account is loaded', () => {
  expect(accountPage()).toContain('id="account-profile" class="account-profile" hidden');
  expect(accountPage()).toContain('Anyone with a Thread link can see your name and photo.');
  const form = { hidden: false, querySelector: vi.fn() };
  mountAccountProfile(form, { account: null, profile: null });
  expect(form.hidden).toBe(true);
  expect(form.querySelector).not.toHaveBeenCalled();
});

it('saves trimmed profile details and uses the server response', async () => {
  const profile = { displayName: 'Omar', avatarUrl: 'https://example.com/photo.jpg' };
  const request = vi.fn().mockResolvedValue({ profile });
  const update = vi.fn();
  await createProfileActions({ request, update, profileBinding: 'profile-session-a' }).save({ displayName: ' Omar ', avatarUrl: ' https://example.com/photo.jpg ' });
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/account/profile', { ...profile, profileBinding: 'profile-session-a' });
  expect(update.mock.calls.map(([state]) => state.status)).toEqual(['loading', 'success']);
  expect(update).toHaveBeenLastCalledWith({ status: 'success', profile, message: 'Profile saved.' });
});

it('allows removing a profile photo and rejects unsafe or invalid profile details', async () => {
  const request = vi.fn().mockResolvedValue({ profile: { displayName: 'Listener', avatarUrl: null } });
  const update = vi.fn();
  const actions = createProfileActions({ request, update, profileBinding: 'profile-session-a' });
  await actions.save({ displayName: 'Listener', avatarUrl: '' });
  expect(request).toHaveBeenCalledWith('/api/account/profile', { displayName: 'Listener', avatarUrl: null, profileBinding: 'profile-session-a' });
  request.mockClear();
  for (const displayName of ['', '  ', 'a'.repeat(81)]) await actions.save({ displayName, avatarUrl: null });
  for (const avatarUrl of ['javascript:alert(1)', 'http://example.com/a', 'https://user:secret@example.com/a', 'https://example.com/' + 'a'.repeat(2048)]) {
    await actions.save({ displayName: 'Omar', avatarUrl });
  }
  expect(request).not.toHaveBeenCalled();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
});

it('deduplicates profile saves and permits retry after a private failure', async () => {
  let fail;
  const request = vi.fn().mockImplementationOnce(() => new Promise((resolve, reject) => { fail = reject; }))
    .mockResolvedValue({ profile: { displayName: 'Omar', avatarUrl: null } });
  const update = vi.fn();
  const actions = createProfileActions({ request, update, profileBinding: 'profile-session-a' });
  const profile = { displayName: 'Omar', avatarUrl: null };
  const pending = actions.save(profile);
  await actions.save(profile);
  expect(request).toHaveBeenCalledTimes(1);
  fail(new Error('private-token'));
  await pending;
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
  expect(JSON.stringify(update.mock.calls)).not.toContain('private-token');
  await actions.save(profile);
  expect(request).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }));
});

it('edits the seeded profile with independent loading, preview, and success state', async () => {
  const element = () => ({ value: '', hidden: false, disabled: false, dataset: {}, events: {}, textContent: '',
    setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener(name, callback) { this.events[name] = callback; } });
  const selectors = Object.fromEntries(['#profile-name', '#profile-photo', '#profile-preview', '#profile-remove-photo', '#profile-message', 'button[type="submit"]'].map(key => [key, element()]));
  const form = { ...element(), querySelector: selector => selectors[selector] };
  let finish;
  const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const data = { account: { provider: 'spotify' }, profileBinding: 'profile-session-a', profile: { displayName: 'Seeded listener', avatarUrl: 'https://example.com/original.jpg' } };
  mountAccountProfile(form, data, request);
  data.profileBinding = 'profile-session-b';
  expect(form.hidden).toBe(false);
  expect(selectors['#profile-name'].value).toBe('Seeded listener');
  expect(selectors['#profile-preview'].src).toBe('https://example.com/original.jpg');
  selectors['#profile-remove-photo'].events.click();
  expect(selectors['#profile-preview'].hidden).toBe(true);
  expect(selectors['#profile-preview'].removeAttribute).toHaveBeenCalledWith('src');
  selectors['#profile-name'].value = '  My own name  ';
  selectors['#profile-photo'].value = '';
  const event = { preventDefault: vi.fn() };
  form.events.submit(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith('/api/account/profile', { displayName: 'My own name', avatarUrl: null, profileBinding: 'profile-session-a' });
  expect(form.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'true');
  expect(selectors['button[type="submit"]'].disabled).toBe(true);
  expect(selectors['#profile-name'].disabled).toBe(true);
  expect(selectors['#profile-message'].textContent).toBe('Saving…');
  finish({ profile: { displayName: 'My own name', avatarUrl: null } });
  await vi.waitFor(() => expect(selectors['button[type="submit"]'].disabled).toBe(false));
  expect(selectors['#profile-name'].value).toBe('My own name');
  expect(selectors['#profile-name'].disabled).toBe(false);
  expect(selectors['#profile-message'].textContent).toBe('Profile saved.');
  expect(form.setAttribute).toHaveBeenLastCalledWith('aria-busy', 'false');
});


it('refuses profile saves without the account snapshot binding', async () => {
  for (const profileBinding of [undefined, null, '', 123]) {
    const request = vi.fn();
    const update = vi.fn();
    await createProfileActions({ request, update, profileBinding }).save({ displayName: 'Omar', avatarUrl: null });
    expect(request).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith({ status: 'error', message: 'Refresh your account before saving your profile.' });
  }
});

it('renders a labeled image picker instead of a photo URL field', () => {
  expect(accountPage()).toContain('type="file"');
  expect(accountPage()).toContain('accept="image/jpeg,image/png,image/webp"');
  expect(accountPage()).toContain('Remove photo');
  expect(accountPage()).not.toContain('Photo URL');
});

it('sends a selected photo atomically with the name and snapshot binding', async () => {
  const request = vi.fn().mockResolvedValue({ profile: { displayName: 'Omar', avatarUrl: 'https://listen.cx/avatar.png' } });
  const actions = createProfileActions({ request, update: vi.fn(), profileBinding: 'original-session' });
  await actions.save({ displayName: ' Omar ', avatarImageBase64: 'cGhvdG8=' });
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/account/profile', {
    displayName: 'Omar', avatarImageBase64: 'cGhvdG8=', profileBinding: 'original-session',
  });
});

it('previews a selected file, blocks saving during decoding, and saves its image with the name', async () => {
  const element = () => ({ value: '', hidden: false, disabled: false, dataset: {}, events: {}, textContent: '',
    setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener(name, callback) { this.events[name] = callback; } });
  const selectors = Object.fromEntries(['#profile-name', '#profile-photo', '#profile-preview', '#profile-remove-photo', '#profile-message', 'button[type="submit"]'].map(key => [key, element()]));
  const form = { ...element(), querySelector: selector => selectors[selector] };
  let decode;
  const bitmap = { width: 192, height: 192, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', () => new Promise(resolve => { decode = resolve; }));
  vi.stubGlobal('document', { createElement: () => ({
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: callback => callback(new Blob(['png'], { type: 'image/png' })),
  }) });
  const request = vi.fn().mockResolvedValue({ profile: { displayName: 'Omar', avatarUrl: 'https://listen.cx/photo.png' } });
  try {
    mountAccountProfile(form, { account: {}, profileBinding: 'original-binding', profile: { displayName: 'Omar', avatarUrl: 'https://example.com/seed.jpg' } }, request);
    selectors['#profile-photo'].files = [{ type: 'image/png', size: 100 }];
    selectors['#profile-photo'].events.change();
    expect(selectors['button[type="submit"]'].disabled).toBe(true);
    expect(selectors['#profile-remove-photo'].disabled).toBe(true);
    form.events.submit({ preventDefault() {} });
    expect(request).not.toHaveBeenCalled();
    decode(bitmap);
    await vi.waitFor(() => expect(selectors['button[type="submit"]'].disabled).toBe(false));
    expect(selectors['#profile-preview'].src).toBe('data:image/png;base64,cG5n');
    form.events.submit({ preventDefault() {} });
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith('/api/account/profile', {
      displayName: 'Omar', avatarImageBase64: 'cG5n', profileBinding: 'original-binding',
    }));
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(selectors['#profile-preview'].src).toBe('https://listen.cx/photo.png');
  } finally { vi.unstubAllGlobals(); }
});
