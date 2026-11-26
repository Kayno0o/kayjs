// What must never reach a browser bundle, shared by `kay build` and `kay check`.

import type { MemberExpression, Node, Program } from 'oxc-parser'
import { loadDeclarations } from './analyze'
import { collectPatternNames } from './shared'

export const SERVER_ONLY_MODULES = new Set([
  '@kayjs/kay/server',
  '@kayjs/kay/config',
  '@kayjs/kay/internal/server',
  '@kayjs/kay/build',
  '@kayjs/kay/test',
  'bun',
  'bun:sqlite',
  'bun:sql',
  'bun:ffi',
  'bun:dns',
  'bun:test',
  'bun:jsc',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'node:crypto',
  'node:dns',
  'node:async_hooks',
  'node:module',
  'node:vm',
  'node:inspector',
  'node:process',
  'node:sqlite',
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
  'crypto',
  'dns',
  'async_hooks',
  'module',
  'vm',
  'os',
  'http2',
  'worker_threads',
  'cluster',
  'dgram',
  'tls',
  'readline',
  'net',
  'http',
  'https',
])

export const SERVER_ONLY_FILTER = new RegExp(`^(?:${[...SERVER_ONLY_MODULES].map(m => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`)

// The client build inlines PUBLIC_* (from its own environment) and NODE_ENV; any other read ships a server variable name and crashes in the browser.
const CLIENT_ENV_KEY = /^(?:PUBLIC_\w*|NODE_ENV)$/

function propKeyName(member: MemberExpression): string | undefined {
  if (!member.computed && member.property.type === 'Identifier')
    return member.property.name
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string')
    return member.property.value
  return undefined
}

function isEnvRoot(node: Node, shadowed: ReadonlySet<string>): 'process' | 'bun' | undefined {
  if (node.type !== 'MemberExpression')
    return undefined
  if (propKeyName(node) !== 'env')
    return undefined
  const obj = node.object
  if (obj.type === 'Identifier') {
    if (obj.name === 'process' && !shadowed.has('process'))
      return 'process'
    if (obj.name === 'Bun' && !shadowed.has('Bun'))
      return 'bun'
  }
  if (obj.type === 'MemberExpression' && obj.object.type === 'Identifier' && obj.object.name === 'globalThis' && !shadowed.has('globalThis')) {
    const key = propKeyName(obj)
    if (key === 'process')
      return 'process'
    if (key === 'Bun')
      return 'bun'
  }
  return undefined
}

/** Byte offset of the first `process.env` or `Bun.env` read outside `load()` for a key the client build does not inline, or `undefined`. */
export function findPrivateEnvOffset(program: Program, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): number | undefined {
  let foundOffset: number | undefined
  const loadCode = new Set<Node>(loadDeclarations(program))

  function visit(node: unknown, shadowed: Set<string>): void {
    if (foundOffset !== undefined || node === null || typeof node !== 'object')
      return
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++)
        visit(node[i], shadowed)
      return
    }
    const n = node as Node
    if (typeof n.type !== 'string' || loadCode.has(n))
      return

    if (n.type === 'MemberExpression') {
      const rootKind = isEnvRoot(n.object, shadowed)
      if (rootKind !== undefined) {
        // Bun.env is never statically inlined in browser bundles.
        if (rootKind === 'bun') {
          foundOffset = n.start
          return
        }
        const key = propKeyName(n)
        if (key === undefined || !isInlined(key))
          foundOffset = n.start
        return
      }
      if (isEnvRoot(n, shadowed) !== undefined) {
        foundOffset = n.start
        return
      }
    }

    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
      const next = new Set(shadowed)
      if (n.type !== 'ArrowFunctionExpression' && n.id !== null)
        next.add(n.id.name)
      for (const p of n.params)
        collectPatternNames(p, next)
      visit(n.body, next)
      return
    }
    if (n.type === 'BlockStatement') {
      const next = new Set(shadowed)
      for (const stmt of n.body) {
        if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
          next.add(stmt.id.name)
        else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
          next.add(stmt.id.name)
      }
      for (const stmt of n.body) {
        if (stmt.type === 'VariableDeclaration') {
          for (const d of stmt.declarations) {
            visit(d.init, next)
            collectPatternNames(d.id, next)
          }
        }
        else {
          visit(stmt, next)
        }
      }
      return
    }
    if (n.type === 'CatchClause') {
      const next = new Set(shadowed)
      collectPatternNames(n.param, next)
      visit(n.body, next)
      return
    }
    if (n.type === 'ForInStatement' || n.type === 'ForOfStatement') {
      visit(n.right, shadowed)
      const next = new Set(shadowed)
      if (n.left.type === 'VariableDeclaration') {
        for (const d of n.left.declarations)
          collectPatternNames(d.id, next)
      }
      visit(n.body, next)
      return
    }
    if (n.type === 'ForStatement') {
      const next = new Set(shadowed)
      if (n.init !== null) {
        if (n.init.type === 'VariableDeclaration') {
          for (const d of n.init.declarations) {
            visit(d.init, next)
            collectPatternNames(d.id, next)
          }
        }
        else {
          visit(n.init, next)
        }
      }
      visit(n.test, next)
      visit(n.update, next)
      visit(n.body, next)
      return
    }

    if (n.type.startsWith('TS'))
      return
    for (const [key, val] of Object.entries(n)) {
      if (key === 'start' || key === 'end' || key === 'type')
        continue
      if (val !== null && typeof val === 'object')
        visit(val, shadowed)
    }
  }

  visit(program, new Set())
  return foundOffset
}

/** True when the module reads `process.env` or `Bun.env` outside its `load()` (stripped from client code) for a key the client build does not inline. */
export function readsPrivateEnv(program: Program, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): boolean {
  return findPrivateEnvOffset(program, isInlined) !== undefined
}
