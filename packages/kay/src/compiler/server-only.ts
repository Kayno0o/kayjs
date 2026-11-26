// What must never reach a browser bundle, shared by `kay build` and `kay check`.

import type { MemberExpression, Node, Program } from 'oxc-parser'
import { loadDeclarations } from './analyze'
import { unwrapTsExpr } from './shared'

export const SERVER_ONLY_MODULES = new Set([
  '@kayjs/kay/server',
  '@kayjs/kay/config',
  '@kayjs/kay/internal/server',
  '@kayjs/kay/internal/ssr',
  '@kayjs/kay/build',
  '@kayjs/kay/test',
  'bun',
  'bun:sqlite',
  'bun:sql',
  'bun:ffi',
  'bun:dns',
  'bun:test',
  'bun:jsc',
  'node:assert',
  'node:assert/strict',
  'node:async_hooks',
  'node:buffer',
  'node:child_process',
  'node:cluster',
  'node:constants',
  'node:crypto',
  'node:dgram',
  'node:diagnostics_channel',
  'node:dns',
  'node:dns/promises',
  'node:domain',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:http2',
  'node:https',
  'node:inspector',
  'node:inspector/promises',
  'node:module',
  'node:net',
  'node:os',
  'node:path',
  'node:path/posix',
  'node:path/win32',
  'node:perf_hooks',
  'node:process',
  'node:punycode',
  'node:querystring',
  'node:readline',
  'node:readline/promises',
  'node:sqlite',
  'node:stream',
  'node:stream/promises',
  'node:stream/web',
  'node:string_decoder',
  'node:test',
  'node:timers',
  'node:timers/promises',
  'node:tls',
  'node:trace_events',
  'node:tty',
  'node:url',
  'node:util',
  'node:v8',
  'node:vm',
  'node:wasi',
  'node:worker_threads',
  'node:zlib',
  'fs',
  'fs/promises',
  'child_process',
  'crypto',
  'dns',
  'dns/promises',
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
  'readline/promises',
  'net',
  'http',
  'https',
  'zlib',
  'perf_hooks',
  'inspector',
  'inspector/promises',
  'sqlite',
  'v8',
  'tty',
  'diagnostics_channel',
  'wasi',
])

export function isServerOnlyModule(source: string): boolean {
  return source.startsWith('node:') || source.startsWith('bun:') || SERVER_ONLY_MODULES.has(source)
}

export const SERVER_ONLY_FILTER = new RegExp(`^(?:node:.+|bun:.+|${[...SERVER_ONLY_MODULES].map(m => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`)

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
  const inner = unwrapTsExpr(node)
  if (inner.type !== 'MemberExpression')
    return undefined
  if (propKeyName(inner) !== 'env')
    return undefined
  const obj = unwrapTsExpr(inner.object)
  if (obj.type === 'Identifier') {
    if (obj.name === 'process' && !shadowed.has('process'))
      return 'process'
    if (obj.name === 'Bun' && !shadowed.has('Bun'))
      return 'bun'
  }
  if (obj.type === 'MemberExpression') {
    const base = unwrapTsExpr(obj.object)
    if (base.type === 'Identifier' && base.name === 'globalThis' && !shadowed.has('globalThis')) {
      const key = propKeyName(obj)
      if (key === 'process')
        return 'process'
      if (key === 'Bun')
        return 'bun'
    }
  }
  return undefined
}

export interface PrivateEnvMatch {
  offset: number
  kind: 'process' | 'bun'
}

/** Offset and source (`process` or `bun`) of the first private `process.env` or `Bun.env` read outside `load()`, or `undefined`. */
export function findPrivateEnv(program: Program, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): PrivateEnvMatch | undefined {
  let found: PrivateEnvMatch | undefined
  const loadCode = new Set<Node>(loadDeclarations(program))

  function visitPattern(pattern: Node | null | undefined, shadowed: Set<string>): void {
    if (found !== undefined || pattern === null || pattern === undefined)
      return
    switch (pattern.type) {
      case 'Identifier':
        shadowed.add(pattern.name)
        return
      case 'AssignmentPattern':
        visit(pattern.right, shadowed)
        visitPattern(pattern.left, shadowed)
        return
      case 'RestElement':
        visitPattern(pattern.argument, shadowed)
        return
      case 'TSParameterProperty':
        visitPattern(pattern.parameter, shadowed)
        return
      case 'ArrayPattern':
        for (const el of pattern.elements) {
          if (el !== null)
            visitPattern(el, shadowed)
        }
        return
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            visitPattern(prop.argument, shadowed)
          }
          else {
            if (prop.computed)
              visit(prop.key, shadowed)
            visitPattern(prop.value, shadowed)
          }
        }
    }
  }

  function visitStatements(body: readonly Node[], shadowed: Set<string>): void {
    for (const stmt of body) {
      const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
      if ((decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') && decl.id !== null)
        shadowed.add(decl.id.name)
    }
    for (const stmt of body) {
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          visit(d.init, shadowed)
          visitPattern(d.id, shadowed)
        }
      }
      else if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration') {
        for (const d of stmt.declaration.declarations) {
          visit(d.init, shadowed)
          visitPattern(d.id, shadowed)
        }
      }
      else {
        visit(stmt, shadowed)
      }
    }
  }

  function visit(node: unknown, shadowed: Set<string>): void {
    if (found !== undefined || node === null || typeof node !== 'object')
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
          found = { offset: n.start, kind: 'bun' }
          return
        }
        const key = propKeyName(n)
        if (key === undefined || !isInlined(key))
          found = { offset: n.start, kind: 'process' }
        return
      }
      const directKind = isEnvRoot(n, shadowed)
      if (directKind !== undefined) {
        found = { offset: n.start, kind: directKind }
        return
      }
    }

    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') {
      const next = new Set(shadowed)
      if (n.type !== 'ArrowFunctionExpression' && n.id !== null)
        next.add(n.id.name)
      for (const p of n.params)
        visitPattern(p, next)
      visit(n.body, next)
      return
    }
    if (n.type === 'Program' || n.type === 'BlockStatement') {
      visitStatements(n.body, new Set(shadowed))
      return
    }
    if (n.type === 'CatchClause') {
      const next = new Set(shadowed)
      visitPattern(n.param, next)
      visit(n.body, next)
      return
    }
    if (n.type === 'ForInStatement' || n.type === 'ForOfStatement') {
      visit(n.right, shadowed)
      const next = new Set(shadowed)
      if (n.left.type === 'VariableDeclaration') {
        for (const d of n.left.declarations)
          visitPattern(d.id, next)
      }
      else {
        visit(n.left, shadowed)
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
            visitPattern(d.id, next)
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
    if (n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSNonNullExpression' || n.type === 'TSTypeAssertion' || n.type === 'TSInstantiationExpression') {
      visit(n.expression, shadowed)
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
  return found
}

/** Byte offset of the first `process.env` or `Bun.env` read outside `load()` for a key the client build does not inline, or `undefined`. */
export function findPrivateEnvOffset(program: Program, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): number | undefined {
  return findPrivateEnv(program, isInlined)?.offset
}

/** True when the module reads `process.env` or `Bun.env` outside its `load()` (stripped from client code) for a key the client build does not inline. */
export function readsPrivateEnv(program: Program, isInlined: (key: string) => boolean = key => CLIENT_ENV_KEY.test(key)): boolean {
  return findPrivateEnvOffset(program, isInlined) !== undefined
}
