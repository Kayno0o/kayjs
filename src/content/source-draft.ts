import type { Collection, Entry } from './index'
import type { CompiledMarkdown, CompileOptions } from './markdown'
import { isDraft } from './drafts'
import { toEntry } from './index'
import { markdownOf } from './load'
import { compileMarkdown } from './markdown'

// A source entry's body compiled, or nothing for one that does not compile, which a draft function then reads as an empty body: a list of entries never fails for one.
export async function compiledSource(body: string, options: CompileOptions): Promise<CompiledMarkdown | undefined> {
  try {
    return await compileMarkdown(body, 1, options)
  }
  catch {
    return undefined
  }
}

// Whether the collection's `draft` holds a source entry back, reading the entry as the app does: `excerpt`, `body` and `html` from its compiled body. `onRead` is told when the function reads the `excerpt` or `html`, which an uncompiled body leaves empty.
export function sourceDraft(collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined, path?: string | undefined, body?: string | undefined }, data: unknown, compiled: CompiledMarkdown | undefined, onRead?: () => void): boolean {
  if (collection.options.draft === undefined)
    return false

  const { readingSpeed, imageSizes } = markdownOf(collection.options)
  const raw = { slug: entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`, file: entry.path ?? entry.slug, data, lines: {}, body: entry.body ?? '', segments: compiled?.segments ?? [], headings: compiled?.headings ?? [], words: compiled?.words ?? 0 }

  const read = toEntry(raw, data, collection.options.components ?? {}, collection.options.localized === true, readingSpeed, imageSizes, undefined)

  const seen = onRead === undefined
    ? read
    : new Proxy(read, { get(target, key) {
      if (key === 'excerpt' || key === 'html')
        onRead()

      return Reflect.get(target, key) as unknown
    } })

  return isDraft(collection.options.draft as ((entry: Entry<unknown>) => boolean) | string, seen)
}
