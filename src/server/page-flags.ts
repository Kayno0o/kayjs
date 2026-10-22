import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'

// What a page module says of its own prerendering, read off its source once: the text of its `prerender` and whether it says `keep: true`.
export async function pageFlags(file: string): Promise<{ prerender: string | undefined, keep: boolean }> {
  const source = await Bun.file(file).text()
  const settings = analyzeServer(source, parseKay(source).server)?.page?.settings
  const text = (name: string) => {
    const value = settings?.get(name)?.value

    return value === undefined ? undefined : source.slice(value.start, value.end)
  }

  return { prerender: settings?.has('prerender') === true ? text('prerender') ?? '' : undefined, keep: text('keep') === 'true' }
}
