import { s, sanitizeHtml } from 'kay'
import { api } from 'kay/server'
import { bodyHtml, MarkdownError } from '../kay/content'

// Where bodyHtml stands a component, which the preview shows as the content it wraps; the sanitizer does not read a tag name with a hyphen, and a heading's anchor points nowhere in the screens.
const COMPONENT_TAGS = /<kay-component\b[^>]*>|<\/kay-component>/g
const HEADING_ANCHOR = /<a href="#[^"]*"[^>]*>(.*?)<\/a>/gs
const LINK = /<a /g

// What the editor's preview keeps besides formatted text: images, and tables as the pages show them.
const KEPT = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'width', 'height'] } }

// A Markdown text rendered by the site's own parser, for the editor's Preview: its structure, with a component shown as its content. The HTML is sanitized, as it is shown inside the screens, which a `<script>` in a text must not run in; a link opens in a new tab so a click never leaves a draft.
export default api()
  .post('/', async ({ body, status }) => {
    try {
      const safe = String(sanitizeHtml((await bodyHtml(body.markdown)).replace(COMPONENT_TAGS, ''), KEPT))

      return { html: safe.replace(HEADING_ANCHOR, '$1').replace(LINK, '<a target="_blank" ') }
    }
    catch (error) {
      if (error instanceof MarkdownError)
        return status(422, error.message)

      throw error
    }
  }, { body: s.Object({ markdown: s.String() }) })
