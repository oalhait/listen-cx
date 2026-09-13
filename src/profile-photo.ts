import { ThreadError } from './thread.js';

export function decodeProfilePhoto(value: unknown): Uint8Array {
  try {
    if (typeof value !== 'string' || !value || value.length > 262144 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if (bytes.length < 57 || bytes.length > 196608) throw new Error();
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((byte, index) => bytes[index] === byte)) throw new Error();
    const view = new DataView(bytes.buffer);
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error();
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || width > 256 || height > 256) throw new Error();
    if (view.getUint32(bytes.length - 12) !== 0 || view.getUint32(bytes.length - 8) !== 0x49454e44) throw new Error();
    return bytes;
  } catch { throw new ThreadError(400, 'invalid_photo', 'Choose a valid photo and try uploading it again.'); }
}
