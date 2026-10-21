import type { EntryRef } from '../kay/contract'
import { ApiError, call } from 'kay'
import markdownApi from '../api/markdown'

const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const SPECIAL = /[&<>]/g

// The HTML the site's Markdown pipeline makes of a text, for the editor's Preview; `entry` is where the text will be saved, whose folder a relative image path is read from.
// A text kay cannot read, such as a component not yet closed, shows why in the pane rather than failing it, as the editor is mid-typing.
export async function previewMarkdown(markdown: string, entry?: EntryRef): Promise<string> {
  const place = entry && entry.slug !== '' ? { collection: entry.collection, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } } : {}

  try {
    return (await call(markdownApi, '/', { method: 'post', body: { markdown, ...place } })).html
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 422)
      return `<p>${error.message.replace(SPECIAL, char => ESCAPED[char]!)}</p>`

    throw error
  }
}
