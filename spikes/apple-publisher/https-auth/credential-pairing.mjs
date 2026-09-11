async function appleErrorCode(response) {
  if (response.status !== 403) return null;
  let reader;
  let timer;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return null;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); });
    const read = async () => {
      const decoder = new TextDecoder();
      let bytes = 0;
      let body = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) return null;
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      return JSON.parse(body)?.errors?.some(error => error?.code === '40300') ? '40300' : null;
    };
    return await Promise.race([read().catch(() => null), timeout]);
  } catch { return null; }
  finally { clearTimeout(timer); try { reader?.cancel().catch(() => {}); } catch {} }
}

export function createCredentialObserver(host, developerToken, report) {
  const original = host.fetch;
  const digest = value => {
    try {
      if (typeof value !== 'string' || !value) return Promise.resolve(null);
      return host.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(buffer => Array.from(new Uint8Array(buffer)).join(','), () => null);
    } catch { return Promise.resolve(null); }
  };
  const configured = digest(developerToken);
  let attempt = null;
  const emit = event => { try { report(event); } catch {} };
  const listener = event => {
    try {
      if (!attempt || event.origin !== 'https://authorize.music.apple.com') return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0' || data.method !== 'authorize' || !Array.isArray(data.params)) return;
      if (typeof data.params[0] === 'string' && data.params[0]) attempt.callback = digest(data.params[0]);
    } catch {}
  };
  function observedFetch(...args) {
    const result = Reflect.apply(original, this, args);
    try {
      if (!attempt || attempt.observed) return result;
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      const method = init?.method ?? input?.method ?? 'GET';
      if (url !== 'https://api.music.apple.com/v1/me/storefront' || method.toUpperCase() !== 'GET') return result;
      attempt.observed = true;
      const callback = attempt.callback;
      const headers = new Headers(init?.headers ?? input?.headers);
      const authorization = headers.get('Authorization');
      const outgoingDeveloper = digest(authorization?.startsWith('Bearer ') ? authorization.slice(7) : null);
      const outgoingUser = digest(headers.get('Music-User-Token'));
      void Promise.all([configured, callback, outgoingDeveloper, outgoingUser]).then(([expectedDeveloper, expectedUser, actualDeveloper, actualUser]) => emit({
        type: 'credential-pairing', freshCallbackObserved: callback !== null,
        developerTokenMatchesConfigured: expectedDeveloper !== null && expectedDeveloper === actualDeveloper,
        userTokenMatchesCallback: expectedUser !== null && expectedUser === actualUser,
      })).catch(() => {});
      void Promise.resolve(result).then(async response => emit({ type: 'storefront-response', httpStatus: response.status, appleErrorCode: await appleErrorCode(response) })).catch(() => {});
    } catch {}
    return result;
  }
  host.fetch = observedFetch;
  host.addEventListener('message', listener, true);
  return {
    begin() { attempt = { callback: null, observed: false }; },
    end() { attempt = null; },
    dispose() { attempt = null; host.removeEventListener('message', listener, true); if (host.fetch === observedFetch) host.fetch = original; },
  };
}
