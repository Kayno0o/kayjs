import type { Elysia } from 'elysia'
import { joinBase, rebaseSrcset } from '../runtime/base'
import { URL_ATTRIBUTES } from '../runtime/url-attributes'

// What may only start a mount point: one slash, then segments; no query, hash or trailing slash.
const BASE_PATH = /^(?:\/[\w.~-]+)+$/
const CSS_URL = /url\(\s*(["']?)(\/(?!\/)[^"')\s]*)\1\s*\)/g

// A path as the router reads it, from where a browser under `base` names it.
export function routerPath(path: string, base: string): string {
  return base !== '' && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || '/' : path
}

// The mount point a config's `base` gives, `''` at the root: `/docs/` reads as `/docs`.
export function basePath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/')
    return ''

  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value

  if (!BASE_PATH.test(trimmed))
    throw new Error(`kay: base is ${value}, which is no path such as /docs`)

  return trimmed
}

// A page's own links, assets, forms and inline styles under the mount point, as it streams out.
export function rebaseHtml(response: Response, base: string): Response {
  const withBase = (url: string) => joinBase(base, url)
  let style = ''
  const rewriter = new HTMLRewriter()

  for (const attribute of URL_ATTRIBUTES) {
    rewriter.on(`[${attribute.replace(':', '\\:')}]`, {
      element(element) {
        element.setAttribute(attribute, withBase(element.getAttribute(attribute)!))
      },
    })
  }

  rewriter.on('[srcset]', {
    element(element) {
      element.setAttribute('srcset', rebaseSrcset(element.getAttribute('srcset')!, withBase))
    },
  })

  // A text node can come in pieces, so a stylesheet is gathered whole before its URLs are read.
  rewriter.on('style', {
    text(text) {
      style += text.text

      if (!text.lastInTextNode) {
        text.remove()

        return
      }

      text.replace(rebaseCss(style, base), { html: true })
      style = ''
    },
  })

  return rewriter.transform(response)
}

export function rebaseCss(css: string, base: string): string {
  return css.replace(CSS_URL, (_, quote: string, url: string) => `url(${quote}${joinBase(base, url)}${quote})`)
}

// The other way round, for a stylesheet the build put under the mount point that a page carries inline, which goes under it as the page goes out.
export function unrebaseCss(css: string, base: string): string {
  return css.replace(CSS_URL, (match, quote: string, url: string) => url.startsWith(`${base}/`) ? `url(${quote}${url.slice(base.length)}${quote})` : match)
}

// A redirect to a path of the site goes under the mount point, whoever made it: a page, a guard, an action or a route the app registered after `pages()`.
export function rebaseRedirects(app: Elysia, base: string): void {
  app.mapResponse({ as: 'scoped' }, ({ responseValue }) => {
    if (!(responseValue instanceof Response))
      return undefined

    const location = responseValue.headers.get('location')

    if (location === null)
      return undefined

    try {
      responseValue.headers.set('location', joinBase(base, location))

      return undefined
    }
    catch {
      // A response whose headers cannot change, such as one `fetch()` returned, goes out as a copy.
      const headers = new Headers(responseValue.headers)

      headers.set('location', joinBase(base, location))

      return new Response(responseValue.body, { status: responseValue.status, statusText: responseValue.statusText, headers })
    }
  })
}
