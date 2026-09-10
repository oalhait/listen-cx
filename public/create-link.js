export function createLinkController({ fetcher = fetch, update }) {
  let pending = false;
  return {
    async submit(value) {
      if (pending) return;
      const url = value.trim();
      if (!url) {
        update({ status: 'error', error: 'Paste a Spotify or Apple Music track link.' });
        return;
      }
      pending = true;
      update({ status: 'loading' });
      try {
        const response = await fetcher('/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ url }),
        });
        const data = await response.json();
        if (!response.ok) {
          update({ status: 'error', error: data.error || 'Could not create a link. Try again.' });
          return;
        }
        await update({ status: 'success', data });
      } catch {
        update({ status: 'error', error: 'Could not create a link. Check your connection and try again.' });
      } finally {
        pending = false;
      }
    },
  };
}
