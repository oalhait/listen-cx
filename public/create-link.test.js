import { expect, it, vi } from 'vitest';
import { createLinkController } from './create-link.js';

it('posts the trimmed input and reports actual metadata with loading state', async () => {
  const data = { link: 'https://listen.test/2345678', title: 'Song', artist: 'Artist', artworkUrl: null };
  const fetcher = vi.fn().mockResolvedValue(Response.json(data));
  const states = [];
  const controller = createLinkController({ fetcher, update: state => states.push(state) });
  await controller.submit(' https://example.com/song ');
  expect(fetcher).toHaveBeenCalledWith('/create', expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: 'https://example.com/song' }) }));
  expect(states).toEqual([{ status: 'loading' }, { status: 'success', data }]);
});
it('blocks duplicate submits until the request finishes', async () => {
  let finish;
  const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const controller = createLinkController({ fetcher, update: vi.fn() });
  const pending = controller.submit('song');
  await controller.submit('song');
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish(Response.json({ link: 'https://listen.test/2345678', title: 'Song', artist: 'Artist' }));
  await pending;
});
it.each([400, 404, 502, 500])('shows API error %s and allows retry', async status => {
  const update = vi.fn();
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'Try another track.' }, { status }));
  const controller = createLinkController({ fetcher, update });
  await controller.submit('song');
  expect(update).toHaveBeenLastCalledWith({ status: 'error', error: 'Try another track.' });
  await controller.submit('song');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('reports a network failure without inventing a link', async () => {
  const update = vi.fn();
  await createLinkController({ fetcher: vi.fn().mockRejectedValue(new Error('network')), update }).submit('song');
  expect(update).toHaveBeenLastCalledWith({ status: 'error', error: 'Could not create a link. Check your connection and try again.' });
});
it('handles empty input without a request', async () => {
  const fetcher = vi.fn();
  const update = vi.fn();
  await createLinkController({ fetcher, update }).submit('  ');
  expect(fetcher).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith({ status: 'error', error: 'Paste a Spotify or Apple Music track link.' });
});
