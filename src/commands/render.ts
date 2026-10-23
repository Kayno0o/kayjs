import type { KayConfig } from '../config'
import type { Command } from './command'
import { loadConfig } from '../config'
import { startRenderServer } from '../dev/render-server'
import { basePath, routerPath } from '../server/base'
import { projectRoot } from './command'
import { USAGES } from './usages'

const SCHEME = /^https?:\/\//
// An HTTP method is a token, as RFC 9110 writes it.
const METHOD = /^[!#$%&'*+.^`|~\w-]+$/
const BODILESS = new Set(['GET', 'HEAD'])
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

// Answers one request as `kay dev` would serve it, the server entry and its plugins included, and prints the body: a server listening on a Unix socket of its own, gone once it answered.
export const render: Command = {
  usage: USAGES.render,
  options: { entry: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' }, header: { type: 'string', multiple: true }, cookie: { type: 'string', multiple: true }, include: { type: 'boolean', short: 'i' }, quiet: { type: 'boolean' } },
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

    const root = projectRoot('render', path)

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
      console.error(`kay render: ${started}`)

      return 1
    }

    try {
      // Sent as the browser would, through the socket, with the host the URL names; a path under `base` loses it, as the proxy in front of such a server takes it off, so a link the page printed renders as it is.
      const init: BunFetchRequestInit = { unix: started.socket, method: verb, headers, body: typeof body === 'string' ? body : null, redirect: 'manual' }
      const response = await fetch(`http://${target.host}${routerPath(target.pathname, baseOf(config?.base))}${target.search}`, init)
      const location = response.headers.get('location')

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
