import { ApiError, call } from 'kay'
import markdownApi from '../api/markdown'

const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const SPECIAL = /[&<>]/g

// The HTML the site's Markdown pipeline makes of a text, for the editor's Preview.
// A text kay cannot read, such as a component not yet closed, shows why in the pane rather than failing it, as the editor is mid-typing.
export async function previewMarkdown(markdown: string): Promise<string> {
  try {
    return (await call(markdownApi, '/', { method: 'post', body: { markdown } })).html
  }
  catch (error) {
    if (error instanceof ApiError && error.status === 422)
      return `<p>${error.message.replace(SPECIAL, char => ESCAPED[char]!)}</p>`

    throw error
  }
}
