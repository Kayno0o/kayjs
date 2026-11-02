// The tag `sanitizeHtml` writes for an image it kept: only `src` and `alt`, each double-quoted with no quote inside.
const IMAGE = /<img\b[^<>]*>/g
const SOURCE = / src="([^"]*)"/
const SITE = 'https://site.invalid'
const ENCODED_SEPARATOR = /%(?:2f|5c)/i

// The path prefixes a reply may show an image from, each ending in the slash a whole segment needs; only a path of the site, never a host or a `//` address.
export function imagePrefixes(images: string | readonly string[] | undefined): string[] {
  const list = typeof images === 'string' ? [images] : [...images ?? []]

  return list.filter(path => path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')).map(path => path.endsWith('/') ? path : `${path}/`)
}

// Whether the browser would request a path under one of the prefixes: the address is resolved as a browser does, so `%2e%2e` and `..` segments count for where they lead.
function under(src: string, prefixes: readonly string[]): boolean {
  if (ENCODED_SEPARATOR.test(src))
    return false

  try {
    const url = new URL(src.replaceAll('&amp;', '&'), SITE)

    return url.origin === SITE && prefixes.some(prefix => url.pathname.startsWith(prefix))
  }
  catch {
    return false
  }
}

// Keeps the images of a sanitized reply that sit under one of the prefixes and drops every other: an image of another host, or of this one outside the paths, could carry the conversation in its address.
export function keepReplyImages(html: string, prefixes: readonly string[]): string {
  return html.replace(IMAGE, (tag) => {
    const src = SOURCE.exec(tag)?.[1]

    return src !== undefined && under(src, prefixes) ? tag : ''
  })
}
