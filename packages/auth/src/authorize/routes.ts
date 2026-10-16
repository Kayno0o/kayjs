import type { Elysia } from 'elysia'
import type { Core } from '../core'
import type { RequestState } from '../state'
import { AUTHORIZATION_SERVER_PATH, authorizationServerMetadata, OPEN_HEADERS, OPENID_CONFIGURATION_PATH, siteRoot } from './metadata'
import { registerClient } from './register'
import { tokenEndpoint } from './token'

const BODY_MAX_LENGTH = 16 * 1024
const DOCUMENT_HEADERS = { ...OPEN_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' }

function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...OPEN_HEADERS, 'access-control-max-age': '86400' } })
}

// The documents and endpoints an MCP client signs in through, on kayjs-auth's own plugin: nothing the app declares.
export function serveOAuthServer(plugin: Elysia, core: Core, stateOf: (ctx: unknown) => RequestState): void {
  for (const path of [AUTHORIZATION_SERVER_PATH, OPENID_CONFIGURATION_PATH]) {
    plugin
      .get(path, ({ request }) => new Response(JSON.stringify(authorizationServerMetadata(core, siteRoot(core, request))), { headers: DOCUMENT_HEADERS }))
      .options(path, preflight)
  }

  const reply = (result: { status: number, body: Record<string, unknown> }): Response => new Response(JSON.stringify(result.body), { status: result.status, headers: { ...OPEN_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'pragma': 'no-cache' } })

  // The body is read here, not by Elysia, so it is capped before it is parsed whatever its content type says.
  const read = async (request: Request): Promise<string | undefined> => {
    const text = await request.text()

    return text.length > BODY_MAX_LENGTH ? undefined : text
  }

  plugin
    .post(`${core.prefix}/oauth/token`, async (ctx) => {
      const state = stateOf(ctx)
      const text = await read(ctx.request)

      if (text === undefined)
        return reply({ status: 400, body: { error: 'invalid_request', error_description: 'The request is too large' } })

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
