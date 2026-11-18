import type { KayConfig } from '../config'
import type { TestOptions } from './site-types'
import { mcpKeySetting } from '../server/mcp-key'
import { checkProxy } from '../server/protection'
import { readSecret } from '../server/secret'

// What a test site holds of the app's keys: the MCP token and the proxy key it sends, the header the latter travels in, and the config that carries them to the server.
export interface SiteKeys {
  mcpKey: string | undefined
  proxyKey: string | undefined
  keyHeader: string | undefined
  config: Pick<KayConfig, 'mcp' | 'proxy'>
}

// The keys of a test site. A site whose config sets `mcp.token` without a value gets a generated one, and a `proxy.key.secret` given as a value turns the check on for this site alone, the environment left as it is.
export function siteKeys(loaded: KayConfig, options: Pick<TestOptions, 'browser' | 'dev'>, root: string): SiteKeys {
  const token = typeof loaded.mcp === 'object' ? loaded.mcp.token : undefined
  const asked = mcpKeySetting(loaded.mcp) !== undefined
  const generated = asked ? crypto.randomUUID() : undefined
  const mcpKey = typeof token === 'string' ? token.trim() : generated
  const keyConfig = checkProxy(loaded.proxy)?.key
  const literal = typeof keyConfig?.secret === 'string' ? keyConfig.secret : undefined

  if (literal !== undefined) {
    if (literal.trim() === '')
      throw new Error('kay: the `secret` of `proxy.key` needs a non-empty key; send no key from a call with an empty header of the name `proxy.key` gives')

    if (options.dev === true)
      throw new Error('kay: the `secret` of `proxy.key` checks nothing with `dev: true`, as `kay dev` does not check the key')

    if (options.browser !== undefined && options.browser !== false)
      throw new Error('kay: the `secret` of `proxy.key` does not reach `open()`, whose browser sends no proxy key header; test the key check without `browser`')
  }

  const configured = keyConfig?.secret === undefined ? undefined : readSecret(keyConfig.secret, root)
  const mcp = mcpKey !== undefined && loaded.mcp !== undefined && loaded.mcp !== false ? { mcp: { ...loaded.mcp === true ? {} : loaded.mcp, token: mcpKey } } : {}

  return {
    mcpKey,
    proxyKey: configured,
    keyHeader: configured === undefined ? undefined : keyConfig?.header,
    config: mcp,
  }
}
