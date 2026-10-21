import { s, sanitizeHtml } from 'kay'
import { api } from 'kay/server'
import { bodyHtml, MarkdownError } from '../kay/content'
import { setCodeAside } from '../preview-code'
import { folderImage, imagesFromFolder } from '../preview-images'
import { UnknownCollection } from '../store'

// Where bodyHtml stands a component, which the preview shows as the content it wraps; the sanitizer does not read a tag name with a hyphen, and a heading's anchor points nowhere in the screens.
const COMPONENT_TAGS = /<kay-component\b[^>]*>|<\/kay-component>/g
const HEADING_ANCHOR = /<a href="#[^"]*"[^>]*>(.*?)<\/a>/gs
const LINK = /<a /g

// What the editor's preview keeps besides formatted text: images, and tables as the pages show them.
const KEPT = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'width', 'height'] } }

// A Markdown text rendered by the site's own parser, for the editor's Preview: its structure, with a component shown as its content, code highlighted by the site's highlighter, and an image written as a path in the entry's folder shown from there. The HTML is sanitized, as it is shown inside the screens, which a `<script>` in a text must not run in; a link opens in a new tab so a click never leaves a draft.
export default api()
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/', async ({ body, status }) => {
    try {
      const html = (await bodyHtml(body.markdown)).replace(COMPONENT_TAGS, '')
      const aside = await setCodeAside(html)
      const place = body.collection !== undefined && body.slug !== undefined ? { collection: body.collection, slug: body.slug, locale: body.locale } : undefined
      const safe = aside.restore(String(sanitizeHtml(place ? imagesFromFolder(aside.html, place) : aside.html, KEPT)))

      return { html: safe.replace(HEADING_ANCHOR, '$1').replace(LINK, '<a target="_blank" ') }
    }
    catch (error) {
      if (error instanceof MarkdownError)
        return status(422, error.message)

      throw error
    }
  }, { body: s.Object({ markdown: s.String(), collection: s.Optional(s.String()), slug: s.Optional(s.String()), locale: s.Optional(s.String()) }) })
  // An image the preview's text names by a path in the entry's folder, read from there: only a PNG, JPEG, WebP, GIF or AVIF inside the collection's folder.
  .get('/image', async ({ query, status }) => {
    const found = await folderImage({ collection: query.collection, slug: query.slug, locale: query.locale }, query.path)

    if (found === undefined)
      return status(404, 'No such image')

    return new Response(Bun.file(found.file), { headers: { 'content-type': found.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }, { query: s.Object({ collection: s.String(), slug: s.String(), path: s.String(), locale: s.Optional(s.String()) }) })
