import type traverseModule from '@babel/traverse'
import type { NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { PropsBinding } from './script'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import { defaultName } from './codegen'

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const POSITION_SUFFIX = / \(\d+:\d+\)$/
const ISLAND_WRAPPER = 'KayIsland'
const require = createRequire(import.meta.url)
let loadedTraverse: typeof traverseModule | undefined

// Loading it takes longer than most compiles, so a server whose `.kay` files all come from the compile cache never does; `kay dev` loads it ahead of time.
export function loadTraverse(): typeof traverseModule {
  loadedTraverse ??= (require('@babel/traverse') as { default: typeof traverseModule }).default

  return loadedTraverse
}

function traverse(...args: Parameters<typeof traverseModule>): void {
  loadTraverse()(...args)
}

export type Rewrites = Map<number, Rewrite & { end: number }>

export interface FoundRewrites {
  rewrites: Rewrites
  diagnostics: Diagnostic[]
  // Set when the generated code does not parse, which means the template or script holds code that is not valid; no rewrite was found.
  syntaxError?: Diagnostic
  // True when the component function's name is read as a value somewhere in it, so a global of that name is shadowed.
  shadowsName: boolean
}

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
// `bindings` are the names read off `__props`: destructured props first, so their indexes match the generated defaults, then server data.
export function findRewrites(code: string, map: SourceMap, accessorSites: Set<number>, bindings: PropsBinding[], componentName: string): FoundRewrites {
  const rewrites: Rewrites = new Map()
  const diagnostics: Diagnostic[] = []
  let ast: t.File

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  }
  catch (error) {
    return { rewrites, diagnostics, syntaxError: syntaxError(error, map), shadowsName: false }
  }

  const propsByLocal = new Map<number, { binding: PropsBinding, index: number }>()
  let shadowsName = false

  for (const [index, binding] of bindings.entries())
    propsByLocal.set(binding.local.start, { binding, index })

  const visitBinding = (scope: Scope, name: string, rewrite: (reference: NodePath) => Rewrite, readOnly: string) => {
    const binding = scope.getBinding(name)

    if (!binding)
      return

    for (const reference of binding.referencePaths) {
      const node = reference.node
      const source = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
      const tag = tagPosition(reference)

      // The closing tag copies the opening one's name, and the opening tag decides how it is spelled.
      if (source === undefined || tag === 'closing')
        continue

      const found = rewrite(reference)

      // Type checking copies a tag as a value too, which must not undo the opening tag's.
      const dynamic = (tag === 'opening' && !isPlainRead(found)) || rewrites.get(source)?.dynamic

      rewrites.set(source, { ...found, end: source + name.length, dynamic })
    }
    for (const violation of binding.constantViolations) {
      const identifier = assignedIdentifier(violation.node, name)
      const source = identifier?.start == null ? undefined : map.toSource(identifier.start)

      if (source !== undefined)
        diagnostics.push({ start: source, end: source + name.length, message: readOnly })
    }
  }

  traverse(ast, {
    Program: (path) => {
      // The export of the function counts as a reference to it, and a tag of that name is the component rendering itself; neither is a read of a global.
      shadowsName = path.scope.getBinding(componentName)?.referencePaths.some(reference => reference.isIdentifier() && !isIslandWrapperArgument(reference) && tagPosition(reference) === undefined) ?? false
    },
    ArrowFunctionExpression: (path) => {
      for (const param of path.node.params) {
        if (param.type !== 'Identifier' || !accessorSites.has(param.start!))
          continue

        visitBinding(path.scope, param.name, reference => withShorthand(reference, param.name, { after: '()' }), `\`${param.name}\` is read-only here; it tracks the current value`)
      }
    },
    VariableDeclarator: (path) => {
      const { id, init } = path.node

      if (id.type !== 'ObjectPattern' || init?.type !== 'Identifier' || init.name !== '__props')
        return

      for (const property of id.properties) {
        if (property.type !== 'ObjectProperty' || property.value.type !== 'Identifier')
          continue

        const source = map.toSource(property.value.start!)
        const prop = source === undefined ? undefined : propsByLocal.get(source)

        if (!prop)
          continue

        const name = property.value.name

        visitBinding(path.scope, name, reference => withShorthand(reference, name, propRead(prop.binding, prop.index, name)), `\`${name}\` is a prop, and props are read-only; copy it into a signal to change it locally`)
      }
    },
  })

  return { rewrites, diagnostics, shadowsName }
}

// Babel's message ends in the position within the generated code, which means nothing to the user; the error lands on the source it was generated from.
function syntaxError(error: unknown, map: SourceMap): Diagnostic {
  const { pos, message } = error as { pos?: number, message: string }
  const start = (pos === undefined ? undefined : map.toSource(pos)) ?? 0
  const hint = message.includes('\'await\'') ? '; a component renders synchronously, so read async data in the `--- server` fence' : ''

  return { start, end: start + 1, message: `${message.replace(POSITION_SUFFIX, '')}${hint}` }
}

// Whether the reference names a component being opened or closed, which JSX spells differently from a read.
function tagPosition(reference: NodePath): 'opening' | 'closing' | undefined {
  let node = reference

  while (node.parentPath?.isJSXMemberExpression() && node.parentPath.node.object === node.node)
    node = node.parentPath

  if (node.parentPath?.isJSXOpeningElement() && node.parentPath.node.name === node.node)
    return 'opening'

  return node.parentPath?.isJSXClosingElement() ? 'closing' : undefined
}

function isIslandWrapperArgument(reference: NodePath): boolean {
  const call = reference.parent

  return call.type === 'CallExpression' && call.callee.type === 'Identifier' && call.callee.name === ISLAND_WRAPPER
}

// `<__props.Icon>` is a tag; anything else a read produces is not.
function isPlainRead(rewrite: Rewrite): boolean {
  return rewrite.before === '__props.' && rewrite.after === undefined
}

// The identifier a write to `name` assigns, so the diagnostic lands on the name instead of on the `++` or `[` the statement starts with.
function assignedIdentifier(violation: t.Node, name: string): t.Identifier | undefined {
  const find = (pattern: t.Node | null | undefined): t.Identifier | undefined => {
    switch (pattern?.type) {
      case 'Identifier':
        return pattern.name === name ? pattern : undefined
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          const found = find(property.type === 'RestElement' ? property.argument : property.value)

          if (found)
            return found
        }

        return undefined
      case 'ArrayPattern':
        for (const element of pattern.elements) {
          const found = find(element)

          if (found)
            return found
        }

        return undefined
      case 'AssignmentPattern':
        return find(pattern.left)
      case 'RestElement':
        return find(pattern.argument)
      default:
        return undefined
    }
  }

  switch (violation.type) {
    case 'AssignmentExpression':
    case 'ForInStatement':
    case 'ForOfStatement':
      return find(violation.left)
    case 'UpdateExpression':
      return find(violation.argument)
    default:
      return undefined
  }
}

// A renamed or quoted key replaces the local name; an unrenamed one keeps it, so the read stays mapped to the source.
// A default applies when the prop is `undefined` and runs only then, like a destructuring default.
function propRead(binding: PropsBinding, index: number, local: string): Rewrite {
  const quoted = !IDENTIFIER.test(binding.key)
  const text = quoted ? `__props[${JSON.stringify(binding.key)}]` : `__props.${binding.key}`
  const access: Rewrite = quoted
    ? { before: '__props[', replace: JSON.stringify(binding.key), after: ']' }
    : { before: '__props.', replace: binding.key === local ? undefined : binding.key }

  if (!binding.fallback)
    return access

  return { before: `(${access.before}`, replace: access.replace, after: `${access.after ?? ''} !== undefined ? ${text} : ${defaultName(index)}())` }
}

// `{ todo }` cannot become `{ todo() }`, so a shorthand property spells its key out first.
function withShorthand(reference: NodePath, name: string, rewrite: Rewrite): Rewrite {
  const parent = reference.parent

  if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === reference.node)
    return { ...rewrite, before: `${name}: ${rewrite.before ?? ''}` }

  return rewrite
}
