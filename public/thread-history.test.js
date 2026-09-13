import { expect, it, vi } from 'vitest';
import { parseManagementLink, createHistoryController } from './thread-history.js';

const origin = 'https://staging.listen.cx';
const capability = 'a'.repeat(22);
const secret = 'b'.repeat(22);
it('recovers only this site’s private management links without navigating to the supplied URL', () => {
  expect(parseManagementLink(`${origin}/t/${capability}#manage=${secret}`, origin)).toEqual({ capability, managementCapability: secret });
  for (const value of [`${origin}/t/${capability}`, `https://evil.test/t/${capability}#manage=${secret}`, `${origin}/t/${capability}#manage=short`, 'javascript:alert(1)', `${origin}/t/short#manage=${secret}`, `https://user@staging.listen.cx/t/${capability}#manage=${secret}`]) {
    expect(() => parseManagementLink(value, origin)).toThrow('private management link');
  }
});
it('sends recovery credentials only in a POST body then reloads private history', async () => {
  const request = vi.fn().mockResolvedValue({ saved: true });
  const data = { threads: [{ capability, title: 'Old Thread' }], signedIn: false };
  const fetcher = vi.fn().mockResolvedValue(Response.json(data));
  const update = vi.fn();
  await createHistoryController({ request, fetcher, update })('import', { capability, managementCapability: secret });
  expect(request).toHaveBeenCalledExactlyOnceWith('/api/my-threads/import', { capability, managementCapability: secret });
  expect(fetcher.mock.calls[0][0]).toBe('/api/my-threads');
  expect(update).toHaveBeenLastCalledWith({ busy: false, data, saved: true });
});
it('clears loading after a failed read and allows a retry', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json({ threads: [] }));
  const update = vi.fn();
  const load = createHistoryController({ fetcher, update });
  await load();
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ busy: false, error: expect.any(String) }));
  await load();
  expect(update).toHaveBeenLastCalledWith({ busy: false, data: { threads: [] }, saved: false });
});
