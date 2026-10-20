function tidy(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const t = u.trim();
  if (t.startsWith('/') && !t.startsWith('//')) return t;
  try {
    const url = new URL(t);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch { /* not a url */ }
  return '';
}

// Fields read from /news/latest.json. image_url is the photo to show; in production that is a
// same-origin WebP under /news/img/YYYYMMDD/. Any other key, including image_url_original, is ignored.
export function parseLatest(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.image_url == null) return null;
  const imageUrl = safeUrl(data.image_url);
  const reportUrl = safeUrl(data.report_url);
  const headline = tidy(data.headline);
  if (!imageUrl || !reportUrl || !headline) return null;
  return {
    date: tidy(data.date),
    headline,
    summary: tidy(data.summary),
    imageUrl,
    credit: tidy(data.image_credit),
    sourceName: tidy(data.source_name),
    sourceUrl: safeUrl(data.source_url),
    reportUrl,
  };
}
