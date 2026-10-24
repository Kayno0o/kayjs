const SERVER_OR_MODULE_FENCE = /^--- (?:server|module)\b/m
const MARKDOWN_BLOCK = /^\s*markdown\b/m
const CODE_HASH = /^#code=([\w-]+)$/
const IMPORT_SOURCE = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

// Whether the playground can run a `kay` example from the docs: a component whose imports are `kay`'s own, with no server fence (data, actions, the request), no `module` fence and no Markdown block, as the browser build has no Markdown parser. A page or an action file is no component, so its fences settle it too.
export function isRunnable(source: string): boolean {
  if (SERVER_OR_MODULE_FENCE.test(source) || MARKDOWN_BLOCK.test(source))
    return false

  return [...source.matchAll(IMPORT_SOURCE)].every(match => (match[1] ?? match[2]) === 'kay')
}

// The source as base64url, the form the link to the playground and its address carry it in.
export function encodeSource(source: string): string {
  return btoa(Array.from(new TextEncoder().encode(source), byte => String.fromCodePoint(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

// The link to the playground with the example in its fragment, which no server sees.
export function playgroundHref(source: string): string {
  return `/getting-started/playground#code=${encodeSource(source)}`
}

export function sourceOfHash(hash: string): string | undefined {
  const encoded = CODE_HASH.exec(hash)?.[1]

  if (encoded === undefined)
    return undefined

  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), char => char.codePointAt(0)!))
  }
  catch {
    return undefined
  }
}
