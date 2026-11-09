const ABSOLUTE_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const DOMAIN_LIKE = /^[a-zA-Z\d.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:[/?#]|$)/;

export function resolveAssistantLink(rawHref) {
  const input = String(rawHref || '').trim();
  if (!input || input.startsWith('//')) return null;
  if (/^song:[a-zA-Z0-9_-]+$/.test(input)) {
    return { href: input, isBlogArticle: false, songId: input.slice(5) };
  }

  let url;
  let isRelative = false;
  try {
    isRelative = input.startsWith('/');
    const candidate = isRelative
      ? new URL(input, 'https://flaretune.invalid').href
      : (ABSOLUTE_SCHEME.test(input) ? input : (DOMAIN_LIKE.test(input) ? `https://${input}` : ''));
    if (!candidate) return null;
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return {
    href: isRelative ? `${url.pathname}${url.search}${url.hash}` : url.href,
    isBlogArticle: false,
    songId: '',
  };
}

export const resolveXiaoaLink = resolveAssistantLink;
