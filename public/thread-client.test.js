import { expect, it, vi } from 'vitest';
import { createThreadController, newCapability, watchManagementLink, copyThreadLink } from './thread-client.js';

function storage() {
  let value = null;
  return { read: () => value, write: next => { value = next; } };
}
it('generates management capabilities in the historical URL-safe format', () => {
  expect(newCapability()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(newCapability()).not.toBe(newCapability());
});
it('reuses a persisted creation key after an interrupted response', async () => {
  const saved = storage();
  const update = vi.fn();
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(Response.json({ publicUrl: '/t/public', managementUrl: '/t/public#manage=private' }));
  await createThreadController({ fetcher, update, storage: saved }).submit('/api/threads', { title: 'Road trip' });
  await createThreadController({ fetcher, update, storage: saved }).submit('/api/threads', { title: 'Road trip' });
  expect(JSON.parse(fetcher.mock.calls[0][1].body).creationKey).toBe(JSON.parse(fetcher.mock.calls[1][1].body).creationKey);
  expect(saved.read()).toBeNull();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'success' }));
});
it('reuses mutation keys when retrying with a fresher revision', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'Thread changed', code: 'stale_revision' }, { status: 409 })).mockResolvedValueOnce(Response.json({ receipt: { revision: 3 } }));
  const update = vi.fn();
  const controller = createThreadController({ fetcher, update });
  await controller.submit('/api/threads/example/contributions', { url: 'song', expectedRevision: 1 });
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', code: 'stale_revision' }));
  await controller.submit('/api/threads/example/contributions', { url: 'song', expectedRevision: 2 });
  const first = JSON.parse(fetcher.mock.calls[0][1].body);
  const second = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(first.requestKey).toBe(second.requestKey);
  expect(second.expectedRevision).toBe(2);
  expect(fetcher.mock.calls[0][1].headers['X-Listen-Action']).toBe('thread');
});
it('blocks duplicate submits until completion and gives the next deliberate action a new key', async () => {
  let finish;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(Response.json({}));
  const controller = createThreadController({ fetcher, update: vi.fn() });
  const pending = controller.submit('/t/example/manage/mutate', { kind: 'close', expectedRevision: 2 });
  await controller.submit('/t/example/manage/mutate', { kind: 'close', expectedRevision: 2 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish(Response.json({}));
  await pending;
  await controller.submit('/t/example/manage/mutate', { kind: 'close', expectedRevision: 2 });
  expect(JSON.parse(fetcher.mock.calls[0][1].body).requestKey).not.toBe(JSON.parse(fetcher.mock.calls[1][1].body).requestKey);
});

it('activates a private link added to an already-open public Thread', () => {
  let hash = '';
  let changed;
  const activate = vi.fn();
  const clearHash = vi.fn(() => { hash = ''; });
  watchManagementLink({ readHash: () => hash, clearHash, onHashChange: handler => { changed = handler; }, activate });
  expect(activate).not.toHaveBeenCalled();
  hash = '#manage=abcdefghijklmnopqrstuv';
  changed();
  expect(clearHash).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith('abcdefghijklmnopqrstuv');
  expect(hash).toBe('');
});

it('selects the actual URL when automatic clipboard copy is unavailable', async () => {
  const link = { href: 'https://listen.test/t/public', textContent: 'Sharing link' };
  const select = vi.fn();
  const copied = await copyThreadLink(link, { writeText: vi.fn().mockRejectedValue(new Error('denied')), select });
  expect(copied).toBe(false);
  expect(link.textContent).toBe(link.href);
  expect(select).toHaveBeenCalledWith(link);
});
