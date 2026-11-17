// Where Bun.markdown (md4c) ends a bare URL, which marked's own rule does not match: a URL starts after a space, a line start or an opening bracket, its host has a dot, and each of its path, query and fragment takes the characters below. A trailing `.`, a `&` before an entity or a closing bracket stays out of the link, and one ending in `_`, `-`, `~`, `=` or any other mark is not a link at all.
const SCHEME = /(?:https?|ftp):\/\/|www\./iy
const HOST = /[a-z\d](?:[\w-]|\.(?=[\w-]))*/iy
const ALNUM_END = /[a-z\d]$/i
const NEXT = /[\s.,!?;&)\]<}]|$/y
const LABEL = /(?:https?|ftp):\/\/[\w.-]*|www\.[\w.-]*/iy
// How far a URL is read: a scan that fails runs to the end of its path, which hostile text repeats, and a longer URL stays text.
const REACH = 2000
const OPENERS = /[\s([{]$/
// Each part, what it may end with and the closers its last character may be followed by instead.
const PARTS: [RegExp, RegExp, RegExp][] = [
  [/\/(?:[\w~%+*/-]|\.(?=[\w~%+*/.-]))*/y, /[a-z\d/]$/i, /\./],
  [/\?[a-z\d](?:[\w~%+*=-]|\.(?=[\w~%+*=.&()-])|&(?!#?[a-z\d]+;)(?=[\w~%+*=.&()-])|\([\w~%+*=.-]*\)|[()](?=[\w~%+*=.&()-]))*/iy, /[a-z\d)]$/i, /[.&)]/],
  [/#[a-z\d](?:[\w~%+*-]|\.(?=[\w~%+*.-]))*/iy, ALNUM_END, /\./],
]

function match(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at

  return pattern.exec(text)?.[0]
}

/** The length of the bare URL `text` starts with, 0 when it is not one. */
export function autolinkLength(whole: string): number {
  const text = whole.slice(0, REACH)
  const scheme = match(SCHEME, text, 0)
  const host = scheme === undefined ? undefined : match(HOST, text, scheme.length)

  if (scheme === undefined || host === undefined || (!ALNUM_END.test(host) && text[scheme.length + host.length] !== '.') || (scheme.length !== 4 && !host.includes('.')))
    return 0

  let end = scheme.length + host.length

  for (const [pattern, last, closer] of PARTS) {
    const found = match(pattern, text, end)

    if (found === undefined)
      continue

    if (!last.test(found) && !closer.test(text[end + found.length] ?? ''))
      return 0

    end += found.length
  }

  return endsAutolink(text, end) && (end < REACH || whole.length === REACH) ? end : 0
}

/** The start of a URL that `text` starts with: the part marked leaves as text when a word is stuck to it. */
export function gluedLength(text: string): number {
  return match(LABEL, text, 0)?.length ?? 0
}

/** Whether `text` starts like a bare URL, which may still not be one. */
export function startsAutolink(text: string): boolean {
  return match(SCHEME, text, 0) !== undefined
}

/** Whether `text` goes on after a link of `length` characters the way Bun.markdown lets one end. */
export function endsAutolink(text: string, length: number): boolean {
  NEXT.lastIndex = length

  return NEXT.test(text)
}

/** Whether a URL may start after `before`, the text it follows in its line. */
export function opensAutolink(before: string): boolean {
  return before === '' || OPENERS.test(before)
}
