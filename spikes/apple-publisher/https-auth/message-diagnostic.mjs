const methods = new Set(['authorize', 'decline', 'unavailable', 'switchUserId', 'close', 'thirdPartyInfo']);

export function messageDiagnostic(event, siteOrigin) {
  let originCategory = 'other';
  if (event.origin === 'https://authorize.music.apple.com') originCategory = 'expected-apple';
  else if (event.origin === siteOrigin) originCategory = 'same-site';
  else if (event.origin === 'null') originCategory = 'opaque';
  else {
    try {
      const url = new URL(event.origin);
      if (url.protocol === 'https:' && (url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com'))) originCategory = 'other-apple';
    } catch {}
  }
  let data = event.data;
  let payloadType = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data === 'object' ? 'object' : 'other';
  if (typeof data === 'string') {
    payloadType = data.length > 65536 ? 'oversized-string' : 'string';
    if (payloadType === 'string') {
      try { data = JSON.parse(data); payloadType = 'string-json'; } catch {}
    }
  }
  const object = data !== null && typeof data === 'object' && !Array.isArray(data);
  const jsonrpc = object && data.jsonrpc === '2.0';
  const method = object && methods.has(data.method) ? data.method : 'unrecognized';
  return { originCategory, payloadType, jsonrpc, method, recognizedSdkCallback: originCategory === 'expected-apple' && payloadType === 'object' && jsonrpc && method !== 'unrecognized' };
}
