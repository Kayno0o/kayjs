// The JSON scripts a server writes into a page for its islands, each parsed once: a streamed page brings more of them as it goes, and a swap the next page's.
const parsed = new WeakMap<Element, unknown>()
const MALFORMED = Symbol('malformed')

export function pageData<T>(selector: string, parse: (text: string) => unknown = JSON.parse): T[] {
  const data: T[] = []

  for (const script of document.querySelectorAll(selector)) {
    if (!parsed.has(script))
      parsed.set(script, parseOnce(script, parse))

    const value = parsed.get(script)

    if (value !== MALFORMED)
      data.push(value as T)
  }

  return data
}

// A script that does not parse is reported once and skipped, so the others still read.
function parseOnce(script: Element, parse: (text: string) => unknown): unknown {
  try {
    return parse(script.textContent ?? '')
  }
  catch (error) {
    console.error(error)

    return MALFORMED
  }
}
