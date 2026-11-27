// Finds the `process.env.NODE_ENV` reads of a module: `kay build` never sets it, so a page it prerenders reads it unset (#3681).

import type { MemberExpression, Node, Program } from 'oxc-parser'
import { walk } from './ast'
import { topLevelNames } from './browser-globals'
import { unwrapTsExpr } from './shared'

const MENTIONS_RE = /\bNODE_ENV\b/

function keyOf(member: MemberExpression): string | undefined {
  if (!member.computed && member.property.type === 'Identifier')
    return member.property.name
  if (member.computed && member.property.type === 'Literal' && typeof member.property.value === 'string')
    return member.property.value
  return undefined
}

// `process.env` or `globalThis.process.env`, with `process` not bound by the module.
function isProcessEnv(node: Node, shadowing: ReadonlySet<string>): boolean {
  const env = unwrapTsExpr(node)
  if (env.type !== 'MemberExpression' || keyOf(env) !== 'env')
    return false
  const proc = unwrapTsExpr(env.object)
  if (proc.type === 'Identifier')
    return proc.name === 'process' && !shadowing.has('process')
  if (proc.type !== 'MemberExpression' || keyOf(proc) !== 'process')
    return false
  const base = unwrapTsExpr(proc.object)
  return base.type === 'Identifier' && base.name === 'globalThis' && !shadowing.has('globalThis')
}

/** Offsets of each `process.env.NODE_ENV` read, `const { NODE_ENV } = process.env` included. */
export function findNodeEnvReads(program: Program, code: string): number[] {
  if (!MENTIONS_RE.test(code))
    return []
  const shadowing = topLevelNames(program)
  const reads: number[] = []
  walk(program, (node) => {
    if (node.type === 'MemberExpression' && keyOf(node) === 'NODE_ENV' && isProcessEnv(node.object, shadowing)) {
      reads.push(node.start)
    }
    else if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init !== null && isProcessEnv(node.init, shadowing)) {
      for (const prop of node.id.properties) {
        if (prop.type === 'Property' && !prop.computed && prop.key.type === 'Identifier' && prop.key.name === 'NODE_ENV')
          reads.push(prop.start)
      }
    }
  })
  return reads
}
