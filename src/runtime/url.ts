import { URL_ATTRIBUTES } from './url-attributes'
// A browser drops tabs and line breaks anywhere in a URL, and spaces and control characters before it.
const SKIPPED = /^[\0-\x20]+|[\t\n\r]/g
const SCHEME = /^[a-z][a-z\d+.-]*:/i
// The web's, a mail's, a phone's, a message's and a blob's, and a media type a browser shows or plays without running anything of its own, unlike `data:text/html` or an SVG document.
const ALLOWED = /^(?:(?:https?|mailto|tel|sms|blob):|data:(?:image\/(?!svg)|audio\/|video\/))/i

// A bound URL with any other scheme, such as a user's `javascript:alert(1)` link, goes out as `unsafe:javascript:alert(1)`, which a browser does nothing with, whatever the CSP says. A relative URL has none, so it is kept.
export function safeUrl(name: string, value: string): string {
  const url = value.replace(SKIPPED, '')

  return URL_ATTRIBUTES.includes(name.toLowerCase()) && SCHEME.test(url) && !ALLOWED.test(url) ? `unsafe:${value}` : value
}
