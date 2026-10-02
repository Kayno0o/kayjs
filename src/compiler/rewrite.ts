import type { NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { PropsBinding } from './script'
import { parse } from '@babel/parser'
import traverseModule from '@babel/traverse'
import { defaultName } from './codegen'

const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule
const IDENTIFIER = /^[A-Z_$][\w$]*$/i

export type Rewrites = Map<number, Rewrite & { end: number }>

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
// `bindings` are the names read off `__props`: destructured props first, so their indexes match the generated defaults, then server data.
export function findRewrites(code: string, map: SourceMap, accessorSites: Set<number>, bindings: PropsBinding[]): { rewrites: Rewrites, diagnostics: Diagnostic[] } {
  const rewrites: Rewrites = new Map()
  const diagnostics: Diagnostic[] = []
  let ast: t.File

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  }
  catch {
    // The script or template has syntax errors, already reported with better positions; generate without rewrites.
    return { rewrites, diagnostics }
  }
  const propsByLocal = new Map<number, { binding: PropsBinding, index: number }>()

  for (const [index, binding] of bindings.entries())
    propsByLocal.set(binding.local.start, { binding, index })

  const visitBinding = (scope: Scope, name: string, rewrite: (reference: NodePath) => Rewrite, readOnly: string) => {
    const binding = scope.getBinding(name)

    if (!binding)
      return

    for (const reference of binding.referencePaths) {
      const node = reference.node
      const source = map.isExact(node.start!) ? map.toSource(node.start!) : undefined

      if (source === undefined)
        continue

      rewrites.set(source, { ...rewrite(reference), end: source + name.length })
    }
    for (const violation of binding.constantViolations) {
      const source = map.toSource(violation.node.start!)

      if (source !== undefined)
        diagnostics.push({ start: source, end: source + name.length, message: readOnly })
    }
  }

  traverse(ast, {
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

  return { rewrites, diagnostics }
}

// A renamed or quoted key replaces the local name; an unrenamed one keeps it, so the read stays mapped to the source.
function propRead(binding: PropsBinding, index: number, local: string): Rewrite {
  const access: Rewrite = !IDENTIFIER.test(binding.key)
    ? { before: '__props[', replace: JSON.stringify(binding.key), after: ']' }
    : { before: '__props.', replace: binding.key === local ? undefined : binding.key }

  if (!binding.fallback)
    return access

  return { before: `(${access.before}`, replace: access.replace, after: `${access.after ?? ''} ?? ${defaultName(index)})` }
}

// `{ todo }` cannot become `{ todo() }`, so a shorthand property spells its key out first.
function withShorthand(reference: NodePath, name: string, rewrite: Rewrite): Rewrite {
  const parent = reference.parent

  if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === reference.node)
    return { ...rewrite, before: `${name}: ${rewrite.before ?? ''}` }

  return rewrite
}
