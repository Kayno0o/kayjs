import type { Collection, Entry } from './index'
import type { CompiledMarkdown, CompileOptions } from './markdown'
import { isDraft } from './drafts'
import { toEntry } from './index'
import { markdownOf } from './load'
import { compileMarkdown, MarkdownError } from './markdown'

// A source entry's body compiled, or nothing for one that does not compile, which a draft function then reads as an empty body.
export async function compiledSource(body: string, options: CompileOptions): Promise<CompiledMarkdown | undefined> {
  try {
    return await compileMarkdown(body, 1, options)
  }
  catch (error) {
    if (error instanceof MarkdownError)
      return undefined

    throw error
  }
}

// Whether the collection's `draft` holds a source entry back, reading the entry as the app does: `excerpt`, `body` and `html` from its compiled body.
export function sourceDraft(collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined, path?: string | undefined, body?: string | undefined }, data: unknown, compiled: CompiledMarkdown | undefined): boolean {
  const { readingSpeed, imageSizes } = markdownOf(collection.options)
  const raw = { slug: entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`, file: entry.path ?? entry.slug, data, lines: {}, body: entry.body ?? '', segments: compiled?.segments ?? [], headings: compiled?.headings ?? [], words: compiled?.words ?? 0 }

  return isDraft(collection.options.draft as ((entry: Entry<unknown>) => boolean) | string, toEntry(raw, data, collection.options.components ?? {}, collection.options.localized === true, readingSpeed, imageSizes, undefined))
}
