// The JSON scripts a server writes into a page for its islands, each parsed once: a streamed page brings more of them as it goes, and a swap the next page's.
const parsed = new WeakMap<Element, unknown>()
const MALFORMED = Symbol('malformed')
// The text of each script that did not parse, read again once it changed, as one read before the stream ended it would.
const failed = new WeakMap<Element, string>()

// The scripts each selector found once the page was parsed, until a swap changes the page: a read that finds nothing, the usual one, then searches the page once.
const found = new Map<string, Element[]>()

// Called where a swap changes the page's elements, so the next read searches the page again.
export function forgetPageData(): void {
  found.clear()
}

// `once` keeps the scripts found for the reads that follow, for a script that is there or not from the page's start, never one a stream brings later.
export function pageData<T>(selector: string, parse: (text: string) => unknown = JSON.parse, once = false): T[] {
  const data: T[] = []
  let scripts = once ? found.get(selector) : undefined

  if (!scripts) {
    scripts = [...document.querySelectorAll(selector)]

    if (once && document.readyState !== 'loading')
      found.set(selector, scripts)
  }

  for (const script of scripts) {
    if (!parsed.has(script) || (failed.has(script) && failed.get(script) !== script.textContent))
      parsed.set(script, parseOnce(script, parse))

    const value = parsed.get(script)

    if (value !== MALFORMED)
      data.push(value as T)
  }

  return data
}

// A script that does not parse is reported once and skipped, so the others still read; one still streaming may fail with each text it has, read again silently.
function parseOnce(script: Element, parse: (text: string) => unknown): unknown {
  const text = script.textContent ?? ''

  try {
    const value = parse(text)

    failed.delete(script)

    return value
  }
  catch (error) {
    if (!failed.has(script))
      console.error(error)

    failed.set(script, text)

    return MALFORMED
  }
}
