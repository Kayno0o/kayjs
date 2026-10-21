import { s, sanitizeHtml } from 'kay'
import { api } from 'kay/server'
import { bodyHtml, MarkdownError } from '../kay/content'

// What the editor's preview keeps besides formatted text: images, and tables as the pages show them.
const KEPT = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'width', 'height'] } }

// A Markdown text rendered by the site's own pipeline, components and highlighting included, for the editor's Preview. The HTML is sanitized, as it is shown inside the screens, which a `<script>` in a text must not run in.
export default api()
  .post('/', async ({ body, status }) => {
    try {
      return { html: String(sanitizeHtml(await bodyHtml(body.markdown), KEPT)) }
    }
    catch (error) {
      if (error instanceof MarkdownError)
        return status(422, error.message)

      throw error
    }
  }, { body: s.Object({ markdown: s.String() }) })
