import type { Elysia } from 'elysia'
import type { Core } from '../core'
import { AUTHORIZATION_SERVER_PATH, authorizationServerMetadata, OPEN_HEADERS, OPENID_CONFIGURATION_PATH, siteRoot } from './metadata'

const DOCUMENT_HEADERS = { ...OPEN_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' }

function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...OPEN_HEADERS, 'access-control-max-age': '86400' } })
}

// The documents and endpoints an MCP client signs in through, on kayjs-auth's own plugin: nothing the app declares.
export function serveOAuthServer(plugin: Elysia, core: Core): void {
  for (const path of [AUTHORIZATION_SERVER_PATH, OPENID_CONFIGURATION_PATH]) {
    plugin
      .get(path, ({ request }) => new Response(JSON.stringify(authorizationServerMetadata(core, siteRoot(core, request))), { headers: DOCUMENT_HEADERS }))
      .options(path, preflight)
  }
}
