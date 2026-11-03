import type { KayConfig } from '../config'
import type { Command } from './command'
import { loadConfig } from '../config-loader'
import { startRenderServer } from '../dev/render-server'
import { basePath, routerPath } from '../server/base'
import { formatOption, printDocument, projectRoot, reportFailure } from './command'

const SCHEME = /^https?:\/\//
// An HTTP method is a token, as RFC 9110 writes it.
const METHOD = /^[!#$%&'*+.^`|~\w-]+$/
const BODILESS = new Set(['GET', 'HEAD'])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

// Answers one request as `kay dev` would serve it, the server entry and its plugins included, and prints the body: a server listening on a Unix socket of its own, gone once it answered.
export const render: Command = {
  usage: 'render <url> [dir] [--entry <file>] [--method <method>] [--body <text>] [--header <name: value>]... [--cookie <name=value>]... [-i|--include] [--quiet] [--format text|json]',
  options: { entry: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' }, header: { type: 'string', multiple: true }, cookie: { type: 'string', multiple: true }, include: { type: 'boolean', short: 'i' }, quiet: { type: 'boolean' }, format: { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals: [url, path] }, refuse) => {
    const { entry: option, method, body, include } = values
    const headerLines = Array.isArray(values.header) ? values.header : []
    const cookies = Array.isArray(values.cookie) ? values.cookie : []

    if (url === undefined)
      return refuse('kay render takes the URL to render, such as /about')

    if ((!url.startsWith('/') || url.startsWith('//')) && !SCHEME.test(url))
      return refuse(`kay render takes a path such as /about or an http URL, not ${url}`)

    const headers = new Headers()

    for (const line of headerLines) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()

      if (colon < 0 || name === '')
        return refuse(`--header takes "name: value", not ${line}`)

      headers.append(name, line.slice(colon + 1).trim())
    }

    if (cookies.length > 0)
      headers.set('cookie', [headers.get('cookie'), ...cookies].filter(Boolean).join('; '))

    const format = formatOption('render', values.format)

    if (format === undefined)
      return 2

    const root = projectRoot('render', path, format)

    if (root === undefined)
      return 1

    const target = new URL(url, 'http://localhost')
    const defaultVerb = body === undefined ? 'GET' : 'POST'
    const verb = typeof method === 'string' ? method.toUpperCase() : defaultVerb

    if (!METHOD.test(verb))
      return refuse(`--method takes an HTTP method, not ${String(method)}`)

    if (typeof body === 'string' && BODILESS.has(verb))
      return refuse(`a ${verb} request has no body, so --body needs another --method, such as POST`)

    // As curl sends `-d`, and as a form posts.
    if (typeof body === 'string' && !headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded')

    const config = await configOf(root)
    const started = await startRenderServer(root, 'render', config, { entry: typeof option === 'string' ? option : undefined })

    if (typeof started === 'string') {
      reportFailure(`kay render: ${started}`, format)

      return 1
    }

    try {
      const began = performance.now()
      // Sent as the browser would, through the socket, with the host the URL names; a path under `base` loses it, as the proxy in front of such a server takes it off, so a link the page printed renders as it is.
      const init: BunFetchRequestInit = { unix: started.socket, method: verb, headers, body: typeof body === 'string' ? body : null, redirect: 'manual' }
      const response = await fetch(`http://${target.host}${routerPath(target.pathname, baseOf(config?.base))}${target.search}`, init)
      const location = response.headers.get('location')

      if (format === 'json') {
        printDocument({ status: response.status, headers: headersOf(response.headers), body: await response.text(), ms: Math.round(performance.now() - began) })

        return response.status >= 400 ? 1 : 0
      }

      if (include === true)
        console.error([`${response.status} ${response.statusText}`, ...[...response.headers].map(([name, value]) => `${name}: ${value}`)].join('\n'))
      else if (values.quiet !== true && REDIRECT_STATUS.has(response.status) && location !== null)
        console.error(`kay render: ${response.status} ${response.statusText}, to ${location}`)
      else if (values.quiet !== true && response.status >= 400)
        console.error(`kay render: ${response.status} ${response.statusText}`)

      // Awaited, as the process exits once this returns, which would cut a long page short on a pipe.
      await Bun.write(Bun.stdout, await response.arrayBuffer())

      return response.status >= 400 ? 1 : 0
    }
    finally {
      await started.stop()
    }
  },
}

// A config that does not load is the server's to report, as it boots.
async function configOf(root: string): Promise<KayConfig | undefined> {
  try {
    return await loadConfig(root)
  }
  catch {
    return undefined
  }
}

// A `base` the server refuses is reported as it boots.
function baseOf(base: string | undefined): string {
  try {
    return basePath(base)
  }
  catch {
    return ''
  }
}

// The response headers as an object, a header sent several times, as `set-cookie` is, an array.
function headersOf(headers: Headers): Record<string, string | string[]> {
  const listed: Record<string, string | string[]> = {}

  for (const [name, value] of headers) {
    if (name === 'set-cookie')
      continue

    listed[name] = value
  }

  const cookies = headers.getSetCookie()

  if (cookies.length > 0)
    listed['set-cookie'] = cookies

  return listed
}
