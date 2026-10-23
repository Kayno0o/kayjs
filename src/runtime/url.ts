import { URL_ATTRIBUTES } from './url-attributes'
// A browser drops tabs and line breaks anywhere in a URL, and spaces and control characters before it.
const SKIPPED = /^[\0-\x20]+|[\t\n\r]/g
const SCHEME = /^[a-z][a-z\d+.-]*:/i
// The web's, a mail's, a phone's, a message's and a blob's, and a media or download type that runs nothing of its own, unlike `data:text/html` or an SVG document.
const ALLOWED = /^(?:(?:https?|mailto|tel|sms|blob):|data:(?:image\/(?!svg)|audio\/|video\/|text\/(?:plain|csv)|application\/(?:pdf|json)))/i
// An SVG drawn as an image runs no script, so it passes where the URL is one, as a QrCode's own `src` is.
const SVG_IMAGE = /^data:image\/svg\+xml[;,]/i
const IMAGE_SOURCES = new Set(['src', 'poster'])

// A bound URL with any other scheme, such as a user's `javascript:alert(1)` link, goes out as `unsafe:javascript:alert(1)`, which a browser does nothing with, whatever the CSP says. A relative URL has none, so it is kept.
export function safeUrl(name: string, value: string): string {
  const url = value.replace(SKIPPED, '')
  const attribute = name.toLowerCase()

  if (!URL_ATTRIBUTES.includes(attribute) || !SCHEME.test(url) || ALLOWED.test(url) || (IMAGE_SOURCES.has(attribute) && SVG_IMAGE.test(url)))
    return value

  return `unsafe:${value}`
}
