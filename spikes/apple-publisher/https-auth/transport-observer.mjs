const appleErrorCodes = new Set(['40000', '40001', '40002', '40003', '40004', '40005', '40006', '40007', '40100', '40101', '40102', '40103', '40300', '40301', '40400', '40401', '40402', '40500', '40900', '42900', '50000', '50300']);

async function appleErrorCode(response) {
  if (response.status < 400) return null;
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
      const codes = JSON.parse(body)?.errors?.map(error => error?.code).filter(code => appleErrorCodes.has(code)) ?? [];
      return codes[0] ?? null;
    };
    return await Promise.race([read().catch(() => null), timeout]);
  } catch { return null; }
  finally { clearTimeout(timer); try { reader?.cancel().catch(() => {}); } catch {} }
}

function safeSnapshot(attempt) {
  return {
    method: attempt.method,
    path: attempt.path,
    issued: attempt.issued,
    responseExposed: attempt.responseExposed,
    httpStatus: attempt.httpStatus,
    appleErrorCode: attempt.appleErrorCode,
  };
}

export function createTransportObserver(host) {
  const original = host.fetch;
  let attempt = null;

  function complete(target) {
    if (!target?.complete) return;
    target.complete();
    target.complete = null;
  }

  function match(args) {
    if (!attempt || attempt.issued) return false;
    try {
      const [input, init] = args;
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, host.location?.origin ?? 'https://invalid.local');
      const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
      return url.origin === 'https://api.music.apple.com' && url.pathname === attempt.path && method === attempt.method;
    } catch { return false; }
  }

  function observedFetch(...args) {
    const observedAttempt = match(args) ? attempt : null;
    if (observedAttempt) observedAttempt.issued = true;
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) {
      if (observedAttempt) complete(observedAttempt);
      throw error;
    }
    if (observedAttempt) {
      void Promise.resolve(result).then(async response => {
        observedAttempt.responseExposed = true;
        observedAttempt.httpStatus = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        observedAttempt.appleErrorCode = await appleErrorCode(response);
        complete(observedAttempt);
      }, () => complete(observedAttempt)).catch(() => complete(observedAttempt));
    }
    return result;
  }

  host.fetch = observedFetch;
  return {
    begin({ method, path }) {
      if (attempt?.complete) throw new Error('Observed transport is still pending');
      if (method !== 'PUT' || typeof path !== 'string' || !/^\/v1\/me\/library\/playlists\/p\.[A-Za-z0-9.-]+\/tracks$/.test(path)) throw new Error('Invalid observed transport');
      let complete;
      const settled = new Promise(resolve => { complete = resolve; });
      attempt = { method, path, issued: false, responseExposed: false, httpStatus: null, appleErrorCode: null, settled, complete };
    },
    async finish(timeoutMilliseconds = 2500) {
      if (!attempt) throw new Error('No observed transport');
      if (attempt.issued && attempt.complete) {
        let timer;
        await Promise.race([attempt.settled, new Promise(resolve => { timer = setTimeout(resolve, timeoutMilliseconds); })]);
        clearTimeout(timer);
        complete(attempt);
      }
      return safeSnapshot(attempt);
    },
    dispose() {
      attempt = null;
      if (host.fetch === observedFetch) host.fetch = original;
    },
  };
}

export async function classifyAppleResponse(response) {
  return {
    httpStatus: Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    appleErrorCode: await appleErrorCode(response),
  };
}
