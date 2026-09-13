
import { expect, it, vi } from 'vitest';
import { prepareProfilePhoto, createPhotoSelection } from './profile-photo.js';

function setup(overrides = {}) {
  const bitmap = { width: 800, height: 600, close: vi.fn() };
  const context = { drawImage: vi.fn() };
  const blob = new Blob(['png'], { type: 'image/png' });
  const canvas = { getContext: () => context, toBlob: callback => callback(blob) };
  const decode = vi.fn().mockResolvedValue(bitmap);
  return { bitmap, context, canvas, decode, options: { decode, makeCanvas: () => canvas, ...overrides } };
}

it('crops a centered square and encodes a bounded PNG without the data URI prefix', async () => {
  const { options, bitmap, canvas, context } = setup();
  expect(await prepareProfilePhoto({ type: 'image/jpeg', size: 3000 }, options)).toEqual({ avatarImageBase64: 'cG5n', previewUrl: 'data:image/png;base64,cG5n' });
  expect(canvas.width).toBe(192);
  expect(canvas.height).toBe(192);
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 100, 0, 600, 600, 0, 0, 192, 192);
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it('rejects unsupported or oversized inputs before decoding', async () => {
  const { options, decode } = setup();
  for (const file of [{ type: 'image/svg+xml', size: 10 }, { type: 'image/jpeg', size: 10485761 }]) {
    await expect(prepareProfilePhoto(file, options)).rejects.toThrow();
  }
  expect(decode).not.toHaveBeenCalled();
});

it('releases the decoded image when PNG output is too large or cannot be encoded', async () => {
  for (const blob of [null, new Blob([new Uint8Array(196609)], { type: 'image/png' })]) {
    const { options, bitmap, canvas } = setup();
    canvas.toBlob = callback => callback(blob);
    await expect(prepareProfilePhoto({ type: 'image/png', size: 100 }, options)).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
  }
});

it('keeps the previous photo after invalid input and ignores obsolete selections', async () => {
  const update = vi.fn();
  let finish;
  const prepare = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ avatarImageBase64: 'new', previewUrl: 'data:new' })
    .mockRejectedValueOnce(new Error('invalid'));
  const selection = createPhotoSelection({ avatarUrl: 'https://example.com/old.png', prepare, update });
  const old = selection.select({});
  await selection.select({});
  finish({ avatarImageBase64: 'old', previewUrl: 'data:old' });
  await old;
  expect(selection.details()).toEqual({ avatarImageBase64: 'new' });
  await selection.select({});
  expect(selection.details()).toEqual({ avatarImageBase64: 'new' });
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error', previewUrl: 'data:new' }));
});

it('removing a photo invalidates a pending decode', async () => {
  let finish;
  const selection = createPhotoSelection({ prepare: () => new Promise(resolve => { finish = resolve; }), update: vi.fn() });
  const pending = selection.select({});
  selection.remove();
  finish({ avatarImageBase64: 'old', previewUrl: 'data:old' });
  await pending;
  expect(selection.details()).toEqual({ avatarUrl: null });
});
