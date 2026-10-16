import type { Elysia } from 'elysia'
import type { Core } from '../core'
import type { RequestState } from '../state'
import { AUTHORIZATION_SERVER_PATH, authorizationServerMetadata, OPEN_HEADERS, OPENID_CONFIGURATION_PATH, rootIsFixed, siteRoot } from './metadata'
import { registerClient } from './register'
import { refused } from './reply'
import { tokenEndpoint } from './token'

const BODY_MAX_LENGTH = 16 * 1024
const DOCUMENT_HEADERS = { ...OPEN_HEADERS, 'content-type': 'application/json; charset=utf-8' }

function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...OPEN_HEADERS, 'access-control-max-age': '86400' } })
}

// The documents and endpoints an MCP client signs in through, on kayjs-auth's own plugin: nothing the app declares.
export function serveOAuthServer(plugin: Elysia, core: Core, stateOf: (ctx: unknown) => RequestState): void {
  for (const path of [AUTHORIZATION_SERVER_PATH, OPENID_CONFIGURATION_PATH]) {
    plugin
      .get(path, ({ request }) => new Response(JSON.stringify(authorizationServerMetadata(core, siteRoot(core, request))), { headers: { ...DOCUMENT_HEADERS, 'cache-control': rootIsFixed(core) ? 'public, max-age=300' : 'private, max-age=300' } }))
      .options(path, preflight)
  }

  const reply = (result: { status: number, body: Record<string, unknown> }): Response => new Response(JSON.stringify(result.body), { status: result.status, headers: { ...OPEN_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'pragma': 'no-cache' } })

  // The body is read here, not by Elysia, and stopped at the cap whatever the request claims to hold.
  const read = async (request: Request): Promise<string | undefined> => {
    if (!request.body)
      return ''

    if (Number(request.headers.get('content-length')) > BODY_MAX_LENGTH)
      return undefined

    const chunks: Uint8Array[] = []
    let size = 0

    for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength

      if (size > BODY_MAX_LENGTH)
        return undefined

      chunks.push(chunk)
    }

    return Buffer.concat(chunks).toString('utf8')
  }

  plugin
    .post(`${core.prefix}/oauth/token`, async (ctx) => {
      const state = stateOf(ctx)
      const text = await read(ctx.request)

      if (text === undefined)
        return reply(refused('invalid_request', 'The request is too large'))

      return reply(await tokenEndpoint(core, state.client, new URLSearchParams(text), siteRoot(core, ctx.request)))
    }, { parse: 'none' })
    .options(`${core.prefix}/oauth/token`, preflight)
    .post(`${core.prefix}/oauth/register`, async (ctx) => {
      const state = stateOf(ctx)
      const text = await read(ctx.request)
      let document: unknown

      try {
        document = text === undefined ? undefined : JSON.parse(text)
      }
      catch {
        document = undefined
      }

      return reply(await registerClient(core, state.client, document))
    }, { parse: 'none' })
    .options(`${core.prefix}/oauth/register`, preflight)
}
