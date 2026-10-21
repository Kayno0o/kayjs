import type { RequestContext } from '../runtime'
import { leavesSite } from '../runtime/base'
import { localizedLink } from '../runtime/i18n'
import { localeState } from '../runtime/locale-state'
import { nodeHttp } from './builtins'

// Thrown by `ctx.redirect()`, `ctx.notFound()` and `ctx.deny()` to end a guard, page or action early; the server turns them into responses.
// A line break would split the `location` header, and Bun refuses any control character there with its own message.
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\0-\x1F\x7F]/
// A scheme other than http(s), such as `javascript:`, which an island's call would hand to `location.assign`.
const OTHER_SCHEME = /^(?!https?:)[a-z][a-z\d+.-]*:/i
// A header holds bytes, so a location such as `/blog/日本語` goes out percent-encoded, as a browser would request it.
const NON_ASCII = /[^\0-\x7F]+/g
const HOST_END = /[/?#]/

// `localize()` and `alternate()` give `//host/path` for a locale served on its own host, which keeps the scheme the page came over; the host must be exactly one of those the app configures, so a port, userinfo or longer name is no match.
function isOwnHost(location: string): boolean {
  const hosts = localeState()?.settings.hosts

  if (hosts === undefined || !location.startsWith('//'))
    return false

  const host = location.slice(2).split(HOST_END, 1)[0]!.toLowerCase()

  return host !== '' && Object.values(hosts).some(own => own.toLowerCase() === host)
}

// With locales by domain, a request on a host the app does not configure (a staging one, localhost) stays there rather than being sent to a configured domain.
function onOwnHost(state: NonNullable<ReturnType<typeof localeState>>): boolean {
  const hosts = state.settings.hosts

  return hosts === undefined || Object.values(hosts).some(own => own.toLowerCase() === state.host?.toLowerCase())
}

export class Redirect {
  readonly location: string

  constructor(location: string, readonly status: number) {
    if (CONTROL.test(location))
      throw new TypeError(`kay: the redirect to ${JSON.stringify(location)} holds a line break or another control character`)

    if (OTHER_SCHEME.test(location.trimStart()))
      throw new TypeError(`kay: a redirect goes to a path or an http(s) URL, not to ${JSON.stringify(location)}`)

    // A path starting with a slash or a backslash is of this site, so one a browser, a proxy or a second decoding would read as another host (`//evil.example`, `/\\evil.example`, `/%2F/evil.example`) is refused; a full URL names its host and is allowed.
    const path = location.trimStart()

    if (!isOwnHost(location) && (path.startsWith('\\') || (path.startsWith('/') && leavesSite(path))))
      throw new TypeError(`kay: the redirect to ${JSON.stringify(location)} is a path which a browser reads as another site; redirect to a full https:// URL for another site, and pass a ?next= param through localPath()`)

    // A page of the site goes to in the locale of the page that redirects, as any link of it is.
    const state = localeState()
    const target = state === undefined || state.implicit || !onOwnHost(state) ? location : localizedLink(state.settings, location, state.locale, state.host)

    this.location = target.toWellFormed().replace(NON_ASCII, encodeURI)
  }
}

export class NotFound {}

export class Denied {
  readonly message: string

  constructor(readonly status: number, message?: string) {
    this.message = message ?? nodeHttp().STATUS_CODES[status] ?? 'Denied'
  }
}

// What `ctx.redirect`, `ctx.notFound` and `ctx.deny` do in every kind of context: a read is redirected with 302, a post with 303.
export function stoppers(request: Request): Pick<RequestContext, 'redirect' | 'notFound' | 'deny'> {
  const status = request.method === 'GET' || request.method === 'HEAD' ? 302 : 303

  return {
    redirect: (location, code = status) => {
      throw new Redirect(location, code)
    },
    notFound: () => {
      throw new NotFound()
    },
    deny: (code = 403, message) => {
      throw new Denied(code, message)
    },
  }
}
