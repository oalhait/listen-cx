import { expect, it, vi } from 'vitest';
import { createMusicConnectionActions, prepareAppleMusic } from './music-connections.js';

function setup(overrides = {}) {
  const request = vi.fn().mockResolvedValue({});
  const navigate = vi.fn();
  const update = vi.fn();
  const music = { authorize: vi.fn().mockResolvedValue('private-user-token') };
  const actions = createMusicConnectionActions({ capability: 'abcdefghijklmnopqrstuv', revision: 4, request, navigate, update, getMusic: () => music, ...overrides });
  return { actions, request, navigate, update, music };
}

it('starts Spotify authorization at the server and navigates only to Spotify', async () => {
  const { actions, request, navigate } = setup();
  request.mockResolvedValue({ url: 'https://accounts.spotify.com/authorize?state=opaque' });
  await actions.authorizeSpotify();
  expect(request).toHaveBeenCalledExactlyOnceWith('/t/abcdefghijklmnopqrstuv/manage/apps/spotify/start', {});
  expect(navigate).toHaveBeenCalledExactlyOnceWith('https://accounts.spotify.com/authorize?state=opaque');
});

it('rejects unexpected authorization destinations', async () => {
  for (const url of ['javascript:alert(1)', 'https://accounts.spotify.com.evil.test/authorize', 'https://user:pass@accounts.spotify.com/authorize']) {
    const { actions, request, navigate, update } = setup();
    request.mockResolvedValue({ url });
    await actions.authorizeSpotify();
    expect(navigate).not.toHaveBeenCalled();
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
  }
});

it('configures Apple Music before authorization without invoking its sign-in', async () => {
  const music = { authorize: vi.fn() };
  const MusicKit = { configure: vi.fn().mockResolvedValue(undefined), getInstance: vi.fn(() => music) };
  const request = vi.fn().mockResolvedValue({ developerToken: 'developer-token' });
  expect(await prepareAppleMusic('/t/thread/manage/apps', request, MusicKit)).toBe(music);
  expect(request).toHaveBeenCalledWith('/t/thread/manage/apps/apple/token', {});
  expect(MusicKit.configure).toHaveBeenCalledWith({ developerToken: 'developer-token', app: { name: 'listen.cx', build: '1' } });
  expect(music.authorize).not.toHaveBeenCalled();
});

it('invokes Apple authorization in the click call and sends the token only in the authorization body', async () => {
  const { actions, request, navigate, music } = setup();
  const pending = actions.authorizeApple();
  expect(music.authorize).toHaveBeenCalledTimes(1);
  await pending;
  expect(request).toHaveBeenCalledExactlyOnceWith('/t/abcdefghijklmnopqrstuv/manage/apps/apple/authorize', { musicUserToken: 'private-user-token' });
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/t/abcdefghijklmnopqrstuv/manage/apps');
});

it('does not send a missing Apple token or expose provider errors', async () => {
  const { actions, request, navigate, music, update } = setup();
  music.authorize.mockRejectedValue(new Error('secret-token-in-sdk-error'));
  await actions.authorizeApple();
  expect(request).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(JSON.stringify(update.mock.calls)).not.toContain('secret-token');
  music.authorize.mockResolvedValue(undefined);
  await actions.authorizeApple();
  expect(request).not.toHaveBeenCalled();
});

it('requires explicit Apple confirmation and sends the current revision with a stable retry key', async () => {
  const { actions, request, navigate } = setup();
  await actions.startSync('apple');
  expect(request).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
  await actions.startSync('apple', true);
  await actions.startSync('apple', true);
  const first = request.mock.calls[0];
  expect(first[0]).toBe('/t/abcdefghijklmnopqrstuv/manage/mutate');
  expect(first[1]).toEqual({ kind: 'connect', provider: 'apple', expectedRevision: 4, requestKey: expect.any(String) });
  expect(request.mock.calls[1][1].requestKey).toBe(first[1].requestKey);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/t/abcdefghijklmnopqrstuv');
});

it('ignores duplicate clicks during authorization and reports revision conflicts without retrying', async () => {
  let finish;
  const { actions, request, update } = setup();
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = actions.authorizeSpotify();
  await actions.authorizeSpotify();
  expect(request).toHaveBeenCalledTimes(1);
  finish({ url: 'https://accounts.spotify.com/authorize' });
  await pending;
  request.mockRejectedValue(Object.assign(new Error('internal detail'), { code: 'stale_revision' }));
  await actions.startSync('spotify');
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', refresh: true }));
  expect(request).toHaveBeenCalledTimes(2);
});
