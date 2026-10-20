// The color an image shows until it loads: six hex digits of its mean color, for an image without transparency.
// Apart from `image.ts`, which an island's bundle carries: only the server and the build's server bundle read or fill these.
const COLOUR = /^[\da-f]{6}$/
// The most runtime images remembered, the oldest dropped first.
const MOST_LEARNED = 4096

// Imported images and the Markdown ones a render registers, by URL.
const built = new Map<string, string>()
// Images read at runtime, by `src`, with the file's version they were read at; an empty color is an image with transparency.
const learned = new Map<string, { version: string, colour: string }>()

// What an imported image's module calls with its URL, which it gives back.
export function registerPlaceholder(url: string, colour: string): string {
  if (COLOUR.test(colour))
    built.set(url, colour)

  return url
}

export function placeholderColour(src: string): string | undefined {
  const colour = built.get(src) ?? learned.get(src)?.colour

  return colour === '' ? undefined : colour
}

// The version of the file `src` names that a color was read from.
export function learnedVersion(src: string): string | undefined {
  return learned.get(src)?.version
}

export function learnPlaceholder(src: string, version: string, colour: string | undefined): void {
  if (learned.size >= MOST_LEARNED && !learned.has(src))
    learned.delete(learned.keys().next().value!)

  learned.set(src, { version, colour: colour !== undefined && COLOUR.test(colour) ? colour : '' })
}
