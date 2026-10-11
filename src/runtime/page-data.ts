// The JSON scripts a server writes into a page for its islands, each parsed once: a streamed page brings more of them as it goes, and a swap the next page's.
const parsed = new WeakMap<Element, unknown>()

export function pageData<T>(selector: string, parse: (text: string) => unknown = JSON.parse): T[] {
  return [...document.querySelectorAll(selector)].map((script) => {
    if (!parsed.has(script))
      parsed.set(script, parse(script.textContent ?? ''))

    return parsed.get(script) as T
  })
}
