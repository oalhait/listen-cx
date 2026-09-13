export async function prepareProfilePhoto(file, {
  decode = file => createImageBitmap(file),
  makeCanvas = () => document.createElement('canvas'),
} = {}) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP image.');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('Choose an image smaller than 10 MB.');
  let bitmap;
  try {
    bitmap = await decode(file);
    if (!bitmap.width || !bitmap.height) throw new Error('Invalid image');
    const canvas = makeCanvas();
    canvas.width = 192;
    canvas.height = 192;
    const side = Math.min(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 192, 192);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.type !== 'image/png' || !blob.size || blob.size > 196608) throw new Error('Image could not be encoded');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const avatarImageBase64 = btoa(binary);
    return { avatarImageBase64, previewUrl: `data:image/png;base64,${avatarImageBase64}` };
  } catch {
    throw new Error('Could not read this image. Try another JPG, PNG, or WebP photo.');
  } finally { bitmap?.close(); }
}

export function createPhotoSelection({ avatarUrl = null, prepare = prepareProfilePhoto, update }) {
  let version = 0;
  let current = { avatarUrl, previewUrl: avatarUrl };
  const emit = (status, message = '') => update({ status, message, previewUrl: current.previewUrl });
  return {
    details: () => current.avatarImageBase64 ? { avatarImageBase64: current.avatarImageBase64 } : { avatarUrl: current.avatarUrl },
    async select(file) {
      if (!file) return;
      const selection = ++version;
      emit('loading', 'Preparing photo…');
      try {
        const photo = await prepare(file);
        if (selection !== version) return;
        current = photo;
        emit('ready', 'Photo ready. Save your profile to upload it.');
      } catch {
        if (selection !== version) return;
        emit('error', 'Choose a JPG, PNG, or WebP image under 10 MB.');
      }
    },
    remove() {
      version++;
      current = { avatarUrl: null, previewUrl: null };
      emit('ready', 'Photo removed. Save your profile to apply this change.');
    },
    reset(avatarUrl) {
      version++;
      current = { avatarUrl, previewUrl: avatarUrl };
      emit('ready');
    },
  };
}
