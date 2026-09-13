import { expect, it, vi } from 'vitest';
import { accountReturn, createAccountActions, prepareAccountAppleMusic, waitForAccountMusicKit } from './account.js';

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
  for (const [provider, host] of [['spotify', 'accounts.spotify.com'], ['apple', 'appleid.apple.com']]) {
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
