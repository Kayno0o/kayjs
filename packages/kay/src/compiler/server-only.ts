// What must never reach a browser bundle, shared by `kay build` and `kay check`.

import type { AstNode } from './analyze'
import { walk } from './analyze'

export const SERVER_ONLY_MODULES = new Set([
  'kay/server',
  '@kayjs/kay/server',
  'bun:sqlite',
  'bun:ffi',
  'bun:dns',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:http2',
  'node:os',
  'node:worker_threads',
  'node:cluster',
  'node:dgram',
  'node:tls',
  'node:readline',
  'fs',
  'fs/promises',
  'child_process',
  'net',
  'http',
  'https',
])

export const SERVER_ONLY_FILTER = new RegExp(`^(?:${[...SERVER_ONLY_MODULES].map(m => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`)

// The client build inlines PUBLIC_* (from its own environment) and NODE_ENV; any other read ships a server variable name and crashes in the browser.
const CLIENT_ENV_KEY = /^(?:PUBLIC_\w*|NODE_ENV)$/

function isProcessEnv(node: AstNode | null | undefined): boolean {
  return node?.type === 'MemberExpression' && !node.computed && node.object?.type === 'Identifier' && node.object.name === 'process' && node.property?.name === 'env'
}

/** True when the module reads `process.env` outside its `load()` (stripped from client code) for a key the client build does not inline. */
export function readsPrivateEnv(program: AstNode, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): boolean {
  let found = false
  walk(program, (node) => {
    if (found)
      return false
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id?.name === 'load')
      return false
    if (node.type === 'MemberExpression' && isProcessEnv(node.object)) {
      const key = node.computed ? node.property?.value : node.property?.name
      found = typeof key !== 'string' || !isInlined(key)
      return false
    }
    if (isProcessEnv(node)) {
      found = true
      return false
    }
    return undefined
  })
  return found
}
