export function connectionReturnUrl(href, origin) {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) return null;
    if (!/^\/t\/[A-Za-z0-9_-]{22}\/manage\/apps$/.test(url.pathname)) return null;
    const parameters = [...url.searchParams];
    if (parameters.length !== 1 || parameters[0][0] !== 'spotify' || !['authorized', 'error'].includes(parameters[0][1])) return null;
    return url.href;
  } catch {
    return null;
  }
}

if (typeof document !== 'undefined') {
  const link = document.querySelector('#continue-connection');
  const destination = link && connectionReturnUrl(link.getAttribute('href'), window.location.origin);
  if (destination) window.location.replace(destination);
}
