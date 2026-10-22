import type { Elysia } from 'elysia'
import type { ProxyConfig } from '../config'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { kayLog } from '../runtime/log'
import { routerPath } from './base'
import { pathOf } from './log'
import { requestId, requestIdHeader } from './protection'
import { sameText } from './seal'
import { isInternal } from './visit'

const KEY_VARIABLE = 'KAY_PROXY_KEY'
const KEY_FILE_VARIABLE = 'KAY_PROXY_KEY_FILE'

// The key the proxy sends: `KAY_PROXY_KEY`, else the trimmed content of the file `KAY_PROXY_KEY_FILE` names; undefined when neither gives a non-empty one.
function proxyKeyValue(): string | undefined {
  const given = process.env[KEY_VARIABLE]?.trim()

  if (given !== undefined && given !== '')
    return given

  const file = process.env[KEY_FILE_VARIABLE]?.trim()

  if (file === undefined || file === '')
    return undefined

  try {
    const content = readFileSync(file, 'utf8').trim()

    return content === '' ? undefined : content
  }
  catch {
    return undefined
  }
}

// Whether `path` is `open` or under it, both read without a trailing slash.
function isOpen(path: string, open: readonly string[]): boolean {
  const bare = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  return open.some(entry => bare === entry || bare.startsWith(`${entry}/`))
}

// Refuses with 403 every request that does not carry the proxy's shared key in the header `proxy.key` names, so a process or a container reaching the port directly skips nothing the proxy does.
// Off under `kay dev`, in a static export, and outside production while no key is given; a production server with `key` and no key to compare with does not boot.
export function requireProxyKey(app: Elysia, proxy: ProxyConfig | undefined, options: { dev: boolean, exported: boolean, base: string, health: string | undefined, logRefused?: ((request: Request, status: number) => void) | undefined }): void {
  const header = proxy?.key

  if (header === undefined || options.dev || options.exported)
    return

  const secret = proxyKeyValue()

  if (secret === undefined) {
    if (process.env.NODE_ENV !== 'production') {
      kayLog('warn', `proxy.key is set but ${KEY_VARIABLE} and ${KEY_FILE_VARIABLE} are not, so requests are not checked for the ${header} header; a production server would not boot`)

      return
    }

    throw new KayError('config-invalid', `kay: proxy.key names the header ${header}, which carries a key read from ${KEY_VARIABLE} or from the file ${KEY_FILE_VARIABLE} names, and neither gives a non-empty one`)
  }

  const open = [...(proxy?.open ?? []).map(entry => entry.length > 1 && entry.endsWith('/') ? entry.slice(0, -1) : entry), ...options.health === undefined ? [] : [options.health]]

  app.onRequest(({ request }) => {
    if (isInternal(request) || isOpen(routerPath(pathOf(request.url), options.base), open))
      return

    const given = request.headers.get(header)

    if (given !== null && sameText(given, secret))
      return

    // This hook runs before the request id and request log hooks, which a response made here skips.
    options.logRefused?.(request, 403)

    return new Response('Forbidden\n', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', [requestIdHeader()]: requestId(request) } })
  })
}
