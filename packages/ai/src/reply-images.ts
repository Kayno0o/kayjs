// The tag `sanitizeHtml` writes for an image it kept: only `src` and `alt`, each double-quoted with no quote inside.
const IMAGE = /<img\b[^<>]*>/g
const SOURCE = / src="([^"]*)"/
const DOT_SEGMENT = /(?:^|\/)\.\.?(?:\/|$|[?#])/

// The path prefixes a reply may show an image from, each ending in the slash a whole segment needs; only a path of the site, never a host or a `//` address.
export function imagePrefixes(images: string | readonly string[] | undefined): string[] {
  const list = typeof images === 'string' ? [images] : [...images ?? []]

  return list.filter(path => path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')).map(path => path.endsWith('/') ? path : `${path}/`)
}

// Keeps the images of a sanitized reply that sit under one of the prefixes and drops every other: an image of another host, or of this one outside the paths, could carry the conversation in its address.
export function keepReplyImages(html: string, prefixes: readonly string[]): string {
  return html.replace(IMAGE, (tag) => {
    const src = SOURCE.exec(tag)?.[1]?.replaceAll('&amp;', '&')

    return src !== undefined && !DOT_SEGMENT.test(src) && prefixes.some(prefix => src.startsWith(prefix)) ? tag : ''
  })
}
