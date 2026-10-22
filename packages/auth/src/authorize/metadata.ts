import type { Core } from '../core'
import { configError, configuredSite } from 'kay/library'

export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'
export const OPENID_CONFIGURATION_PATH = '/.well-known/openid-configuration'
const TRAILING_SLASH = /\/$/

// Shared by every document and endpoint a client reads before it has a token, which a page of another site may ask for.
export const OPEN_HEADERS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version' }

// Whether the issuer can be named: the site's origin is configured, or the app is not in production, where the Host header would name it.
export function rootUsable(core: Core): boolean {
  return rootIsFixed(core) || process.env.NODE_ENV !== 'production'
}

// Where the app is served, mount point included: the `site` and `base` kay.config.ts sets, else the `site` of `createAuth`, else the request's origin outside production, where the Host header would name the issuer.
export function siteRoot(core: Core, request: Request): string {
  const fixed = configuredSite()?.origin ?? core.url

  if (!rootUsable(core))
    throw configError('the OAuth server needs the site\'s origin in production: set `site` in kay.config.ts or in createAuth, as the Host header cannot name the issuer')

  return (fixed ?? new URL(request.url).origin).replace(TRAILING_SLASH, '')
}

// The endpoints of the OAuth server, under the site's root.
export function endpoints(core: Core, root: string) {
  return {
    authorization: `${root}${core.pages!.prefix}/oauth/authorize`,
    token: `${root}${core.prefix}/oauth/token`,
    registration: `${root}${core.prefix}/oauth/register`,
  }
}

// RFC 8414 metadata, which an MCP client reads from the OpenID Connect location too.
export function authorizationServerMetadata(core: Core, root: string): Record<string, unknown> {
  const where = endpoints(core, root)

  return {
    issuer: root,
    authorization_endpoint: where.authorization,
    token_endpoint: where.token,
    registration_endpoint: where.registration,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    ...core.scopes.size > 0 && { scopes_supported: [...core.scopes] },
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

// RFC 9728 metadata of the MCP endpoint at `resource`.
export function protectedResourceMetadata(core: Core, root: string, resource: string, name: string): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [root],
    bearer_methods_supported: ['header'],
    resource_name: name,
    ...core.scopes.size > 0 && { scopes_supported: [...core.scopes] },
  }
}

// Whether the site's origin is configured, else it is the request's own, which anyone sending a Host header names.
export function rootIsFixed(core: Core): boolean {
  return (configuredSite()?.origin ?? core.url) !== undefined
}
