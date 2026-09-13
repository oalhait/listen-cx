function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function publicUrl(value: string | undefined, httpsOnly = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === "https:" || !httpsOnly && url.protocol === "http:";
    return allowedProtocol && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function socialMetadata({ title, description, url, image, imageAlt, type = "website" }: {
  title: string;
  description: string;
  url?: string;
  image?: string | null;
  imageAlt?: string;
  type?: "website" | "music.song";
}): string {
  const canonical = publicUrl(url);
  const artwork = publicUrl(image ?? undefined, true);
  return [
    `<meta name="description" content="${escape(description)}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="listen.cx">`,
    `<meta property="og:title" content="${escape(title)}">`,
    `<meta property="og:description" content="${escape(description)}">`,
    canonical ? `<meta property="og:url" content="${escape(canonical)}">` : "",
    artwork ? `<meta property="og:image" content="${escape(artwork)}">` : "",
    artwork && imageAlt ? `<meta property="og:image:alt" content="${escape(imageAlt)}">` : "",
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escape(title)}">`,
    `<meta name="twitter:description" content="${escape(description)}">`,
    artwork ? `<meta name="twitter:image" content="${escape(artwork)}">` : "",
    artwork && imageAlt ? `<meta name="twitter:image:alt" content="${escape(imageAlt)}">` : "",
    canonical ? `<link rel="canonical" href="${escape(canonical)}">` : "",
  ].join("");
}
