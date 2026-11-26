// Lexical-scope AST walking shared by the DOM compiler: shadow-aware visitor, free-identifier rewrites and reference checks.

import type { ArrowFunctionExpression, BlockStatement, Function as OxcFunction, JSXElement, JSXFragment, Node, Program } from 'oxc-parser'
import { visitorKeys } from 'oxc-parser'
import { walk } from './ast'
import { SourceEditor } from './patch'
import { collectPatternNames, containsJsx, isJsxNode, unwrapParens, unwrapTsExpr } from './shared'

// Names whose every binding in the file is a `const` holding an array literal: only those can be looped once without tracking.
export function literalArrayConsts(program: Program): Set<string> {
  const literal = new Set<string>()
  const other = new Set<string>()
  const bindOther = (pattern: Node | null | undefined): void => {
    if (pattern !== null && pattern !== undefined)
      collectPatternNames(pattern, other)
  }
  walk(program, (node) => {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        const init = decl.init !== null ? unwrapTsExpr(decl.init) : null
        if (node.kind === 'const' && decl.id.type === 'Identifier' && init?.type === 'ArrayExpression')
          literal.add(decl.id.name)
        else
          bindOther(decl.id)
      }
    }
    else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
      bindOther(node.local)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      bindOther(node.id)
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const param of node.params)
        bindOther(param)
    }
    else if (node.type === 'CatchClause') {
      bindOther(node.param)
    }
  })
  for (const name of other)
    literal.delete(name)
  return literal
}

export interface ScopedWalkCallbacks {
  shouldStop?: (() => boolean) | undefined
  onIdentifier?: ((node: Extract<Node, { type: 'Identifier' }>, shadowed: ReadonlySet<string>) => void) | undefined
  onWrite?: ((name: string, shadowed: ReadonlySet<string>) => void) | undefined
  onShorthandProperty?: ((node: Extract<Node, { type: 'Property' }>, shadowed: ReadonlySet<string>) => boolean) | undefined
  onJsx?: ((node: JSXElement | JSXFragment, shadowed: ReadonlySet<string>) => void) | undefined
  onFunction?: ((node: ArrowFunctionExpression | OxcFunction, shadowed: ReadonlySet<string>) => boolean) | undefined
}

/** Single lexical-scope AST visitor shared by `referencesAny`, `collectMutatedNames`, and `rewriteFreeIdentifiers` (respects `for...of`, `switch`, `catch (e)`, class members, labels, and TS nodes). */
export function walkScoped(rootNode: Node, callbacks: ScopedWalkCallbacks): void {
  const { shouldStop, onIdentifier, onWrite, onShorthandProperty, onJsx, onFunction } = callbacks

  const reportPatternWrites = (target: Node, shadowed: Set<string>): void => {
    if (onWrite === undefined)
      return
    const written = new Set<string>()
    collectPatternNames(target, written)
    for (const name of written) {
      if (!shadowed.has(name))
        onWrite(name, shadowed)
    }
  }

  function visitPatternDefaults(pattern: Node | null | undefined, shadowed: Set<string>): void {
    if (pattern === null || pattern === undefined || shouldStop?.())
      return
    switch (pattern.type) {
      case 'AssignmentPattern':
        visitPatternDefaults(pattern.left, shadowed)
        visit(pattern.right, shadowed)
        return
      case 'RestElement':
        visitPatternDefaults(pattern.argument, shadowed)
        return
      case 'TSParameterProperty':
        visitPatternDefaults(pattern.parameter, shadowed)
        return
      case 'ArrayPattern':
        for (const el of pattern.elements)
          visitPatternDefaults(el, shadowed)
        return
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            visitPatternDefaults(prop.argument, shadowed)
          }
          else {
            if (prop.computed)
              visit(prop.key, shadowed)
            visitPatternDefaults(prop.value, shadowed)
          }
        }
    }
  }

  function visit(node: Node | null | undefined, shadowed: Set<string>): void {
    if (node === null || node === undefined || shouldStop?.())
      return

    if (onJsx !== undefined && isJsxNode(node)) {
      onJsx(node, shadowed)
      return
    }

    switch (node.type) {
      case 'Identifier': {
        if (!shadowed.has(node.name))
          onIdentifier?.(node, shadowed)
        return
      }
      case 'MemberExpression': {
        visit(node.object, shadowed)
        if (node.computed)
          visit(node.property, shadowed)
        return
      }
      case 'MetaProperty':
      case 'BreakStatement':
      case 'ContinueStatement':
        return
      case 'LabeledStatement': {
        visit(node.body, shadowed)
        return
      }
      case 'Property': {
        if (node.computed)
          visit(node.key, shadowed)
        if (node.shorthand && node.value.type === 'Identifier' && onShorthandProperty?.(node, shadowed) === true)
          return
        visit(node.value, shadowed)
        return
      }
      case 'MethodDefinition':
      case 'PropertyDefinition': {
        if (node.computed)
          visit(node.key, shadowed)
        visit(node.value, shadowed)
        return
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const next = new Set(shadowed)
        if (node.id !== null)
          next.add(node.id.name)
        visit(node.superClass, shadowed)
        visit(node.body, next)
        return
      }
      case 'CatchClause': {
        const next = new Set(shadowed)
        visitPatternDefaults(node.param, next)
        collectPatternNames(node.param, next)
        visit(node.body, next)
        return
      }
      case 'ForStatement': {
        const next = new Set(shadowed)
        if (node.init !== null) {
          if (node.init.type === 'VariableDeclaration') {
            for (const d of node.init.declarations) {
              visit(d.init, next)
              visitPatternDefaults(d.id, next)
              collectPatternNames(d.id, next)
            }
          }
          else {
            visit(node.init, next)
          }
        }
        visit(node.test, next)
        visit(node.update, next)
        visit(node.body, next)
        return
      }
      case 'AssignmentExpression': {
        reportPatternWrites(node.left, shadowed)
        visit(node.left, shadowed)
        visit(node.right, shadowed)
        return
      }
      case 'UpdateExpression': {
        if (onWrite !== undefined && node.argument.type === 'Identifier' && !shadowed.has(node.argument.name))
          onWrite(node.argument.name, shadowed)
        visit(node.argument, shadowed)
        return
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        visit(node.right, shadowed)
        const next = new Set(shadowed)
        if (node.left.type === 'VariableDeclaration') {
          for (const d of node.left.declarations) {
            visitPatternDefaults(d.id, next)
            collectPatternNames(d.id, next)
          }
        }
        else {
          reportPatternWrites(node.left, next)
          visit(node.left, next)
        }
        visit(node.body, next)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant, shadowed)
        const caseShadow = new Set(shadowed)
        for (const c of node.cases) {
          for (const stmt of c.consequent) {
            if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
              caseShadow.add(stmt.id.name)
            else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
              caseShadow.add(stmt.id.name)
          }
        }
        for (const c of node.cases) {
          visit(c.test, caseShadow)
          for (const stmt of c.consequent) {
            if (stmt.type === 'VariableDeclaration') {
              for (const d of stmt.declarations) {
                visit(d.init, caseShadow)
                visitPatternDefaults(d.id, caseShadow)
                collectPatternNames(d.id, caseShadow)
              }
            }
            else {
              visit(stmt, caseShadow)
            }
          }
        }
        return
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
      case 'FunctionDeclaration': {
        if (node !== rootNode && onFunction?.(node, shadowed) === true)
          return
        const nextShadow = new Set(shadowed)
        if (node.type !== 'ArrowFunctionExpression' && node.id !== null)
          nextShadow.add(node.id.name)
        for (const p of node.params) {
          visitPatternDefaults(p, nextShadow)
          collectPatternNames(p, nextShadow)
        }
        visit(node.body, nextShadow)
        return
      }
      case 'BlockStatement': {
        const nextShadow = new Set(shadowed)
        for (const stmt of node.body) {
          if (stmt.type === 'FunctionDeclaration' && stmt.id !== null)
            nextShadow.add(stmt.id.name)
          else if (stmt.type === 'ClassDeclaration' && stmt.id !== null)
            nextShadow.add(stmt.id.name)
        }
        for (const stmt of node.body) {
          if (stmt.type === 'VariableDeclaration') {
            for (const d of stmt.declarations) {
              visit(d.init, nextShadow)
              visitPatternDefaults(d.id, nextShadow)
              collectPatternNames(d.id, nextShadow)
            }
          }
          else {
            visit(stmt, nextShadow)
          }
        }
        return
      }
      case 'VariableDeclaration': {
        const nextShadow = new Set(shadowed)
        for (const d of node.declarations) {
          visit(d.init, nextShadow)
          visitPatternDefaults(d.id, nextShadow)
          collectPatternNames(d.id, nextShadow)
        }
        return
      }
      case 'VariableDeclarator': {
        visit(node.init, shadowed)
        visitPatternDefaults(node.id, shadowed)
        return
      }
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression': {
        visit(node.expression, shadowed)
        return
      }
      default: {
        if (node.type.startsWith('TS'))
          return
        const keys = visitorKeys[node.type]
        if (keys !== undefined) {
          const rec = node as unknown as Record<string, unknown>
          for (let i = 0; i < keys.length; i++) {
            const val = rec[keys[i]!]
            if (Array.isArray(val)) {
              for (let j = 0; j < val.length; j++) {
                const item = val[j]
                if (item !== null && typeof item === 'object' && 'type' in item)
                  visit(item as Node, shadowed)
              }
            }
            else if (val !== null && typeof val === 'object' && 'type' in val) {
              visit(val as Node, shadowed)
            }
          }
          return
        }
        for (const [key, val] of Object.entries(node)) {
          if (key === 'start' || key === 'end' || key === 'type')
            continue
          if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
              const item = val[i]
              if (item !== null && typeof item === 'object' && 'type' in item)
                visit(item as Node, shadowed)
            }
          }
          else if (val !== null && typeof val === 'object' && 'type' in val) {
            visit(val as Node, shadowed)
          }
        }
      }
    }
  }

  visit(rootNode, new Set())
}

/** Returns true if every free reference to `name` in `stmts` sits solely in a JSX slot (`{name}` or component prop `p={name}`), so deferring `const name = <jsx>` to `() => <jsx>` is observationally equivalent and preserves hydration order. */
export function isSafeLazyJsxRef(name: string, stmts: readonly Node[]): boolean {
  let safe = true
  let uses = 0
  const ancestors: Node[] = []
  const isSlotContext = (): boolean => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const p = ancestors[i]!
      if (p.type === 'ParenthesizedExpression' || p.type === 'LogicalExpression' || p.type === 'ConditionalExpression')
        continue
      if (p.type === 'JSXExpressionContainer') {
        const holder = ancestors[i - 1]
        return holder !== undefined && (holder.type === 'JSXElement' || holder.type === 'JSXFragment' || holder.type === 'JSXAttribute')
      }
      return false
    }
    return false
  }
  const visit = (node: Node | null | undefined, shadowed: Set<string>): void => {
    if (!safe || node === null || node === undefined)
      return
    if (node.type === 'Identifier') {
      if (node.name !== name || shadowed.has(name))
        return
      const parent = ancestors[ancestors.length - 1]
      if (parent !== undefined && (
        (parent.type === 'MemberExpression' && !parent.computed && parent.property === node)
        || (parent.type === 'Property' && !parent.computed && parent.key === node && !parent.shorthand)
        || (parent.type === 'LabeledStatement' && parent.label === node)
      )) {
        return
      }
      uses++
      if (!isSlotContext())
        safe = false
      return
    }
    if (node.type === 'BlockStatement' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
      const next = new Set(shadowed)
      if (node.type !== 'BlockStatement') {
        if (node.type !== 'ArrowFunctionExpression' && node.id !== null)
          next.add(node.id.name)
        for (const p of node.params)
          collectPatternNames(p, next)
        ancestors.push(node)
        visit(node.body, next)
        ancestors.pop()
        return
      }
      for (const s of node.body) {
        if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id !== null)
          next.add(s.id.name)
      }
      ancestors.push(node)
      for (const s of node.body) {
        if (s.type === 'VariableDeclaration') {
          for (const d of s.declarations) {
            visit(d.init, next)
            collectPatternNames(d.id, next)
          }
        }
        else {
          visit(s, next)
        }
      }
      ancestors.pop()
      return
    }
    if (node.type.startsWith('TS') && node.type !== 'TSAsExpression' && node.type !== 'TSSatisfiesExpression' && node.type !== 'TSNonNullExpression' && node.type !== 'TSTypeAssertion')
      return
    ancestors.push(node)
    const keys = visitorKeys[node.type]
    if (keys !== undefined) {
      const rec = node as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length; i++) {
        const val = rec[keys[i]!]
        if (Array.isArray(val)) {
          for (let j = 0; j < val.length; j++) {
            const item = val[j]
            if (item !== null && typeof item === 'object' && 'type' in item)
              visit(item as Node, shadowed)
          }
        }
        else if (val !== null && typeof val === 'object' && 'type' in val) {
          visit(val as Node, shadowed)
        }
      }
    }
    ancestors.pop()
  }
  const topShadow = new Set<string>()
  for (const s of stmts) {
    if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) {
        visit(d.init, topShadow)
        collectPatternNames(d.id, topShadow)
      }
    }
    else {
      visit(s, topShadow)
    }
  }
  return safe && uses > 0
}

/** Returns true if `rootNode` contains any free identifier reference to a name in `names`. */
export function referencesAny(rootNode: Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0)
    return false
  let found = false
  walkScoped(rootNode, {
    shouldStop: () => found,
    onIdentifier(node) {
      if (names.has(node.name))
        found = true
    },
  })
  return found
}

/** Returns the subset of `candidates` that are freely assigned, updated, or targeted by `for...in`/`for...of` inside `rootNode`. */
export function collectMutatedNames(rootNode: Node | null | undefined, candidates: ReadonlySet<string>): Set<string> {
  const mutated = new Set<string>()
  if (rootNode === null || rootNode === undefined || candidates.size === 0)
    return mutated
  walkScoped(rootNode, {
    onWrite(name) {
      if (candidates.has(name))
        mutated.add(name)
    },
  })
  return mutated
}

/** Rewrites free identifier reads inside an AST node while respecting lexical scopes, class/object keys, labels, and nested JSX/components. */
export function rewriteFreeIdentifiers(
  source: string,
  rootNode: Node,
  replacements: ReadonlyMap<string, string>,
  jsxNodes: WeakSet<Node>,
  onJsx?: (node: JSXElement | JSXFragment, rewrites: ReadonlyMap<string, string>) => string,
  onFunction?: (fn: ArrowFunctionExpression | OxcFunction, rewrites: ReadonlyMap<string, string>) => string | undefined,
): string {
  if (replacements.size === 0 && (onJsx === undefined || !containsJsx(rootNode, jsxNodes)))
    return source.slice(rootNode.start, rootNode.end)

  const offset = rootNode.start
  const editor = new SourceEditor(source.slice(rootNode.start, rootNode.end))
  const activeMap = (shadowed: ReadonlySet<string>): ReadonlyMap<string, string> =>
    shadowed.size === 0 ? replacements : new Map([...replacements].filter(([k]) => !shadowed.has(k)))

  walkScoped(rootNode, {
    onJsx: onJsx === undefined
      ? undefined
      : (node, shadowed) => {
          editor.replace(node.start - offset, node.end - offset, onJsx(node, activeMap(shadowed)))
        },
    onIdentifier(node) {
      const rep = replacements.get(node.name)
      if (rep !== undefined)
        editor.replace(node.start - offset, node.end - offset, rep)
    },
    onShorthandProperty(node, shadowed) {
      if (node.value.type !== 'Identifier')
        return false
      const name = node.value.name
      if (!shadowed.has(name) && replacements.has(name)) {
        editor.replace(node.start - offset, node.end - offset, `${name}: ${replacements.get(name)}`)
        return true
      }
      return false
    },
    onFunction: onFunction === undefined
      ? undefined
      : (node, shadowed) => {
          const compiled = onFunction(node, activeMap(shadowed))
          if (compiled !== undefined) {
            editor.replace(node.start - offset, node.end - offset, compiled)
            return true
          }
          return false
        },
  })
  return editor.toString()
}

export function extractKeyExpr(jsxEl: Node): Node | undefined {
  if (jsxEl.type !== 'JSXElement')
    return undefined
  for (const attr of jsxEl.openingElement.attributes) {
    if (attr.type === 'JSXAttribute' && attr.name.type === 'JSXIdentifier' && attr.name.name === 'key') {
      if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
        return attr.value.expression
      if (attr.value?.type === 'Literal')
        return attr.value
    }
  }
  return undefined
}

export function extractBlockKeyExpr(block: BlockStatement): Node | undefined {
  const blockLocals = new Set<string>()
  for (const stmt of block.body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations)
        collectPatternNames(d.id, blockLocals)
    }
    else if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && stmt.id !== null) {
      blockLocals.add(stmt.id.name)
    }
  }
  let found: Node | undefined
  walk(block, (child) => {
    if (found !== undefined)
      return false
    if (child.type === 'ArrowFunctionExpression' || child.type === 'FunctionExpression' || child.type === 'FunctionDeclaration')
      return false
    if (child.type === 'ReturnStatement' && child.argument !== null) {
      const arg = unwrapParens(child.argument)
      const k = extractKeyExpr(arg)
      // Only hoist key expressions that don't depend on block-local variables.
      if (k !== undefined && !referencesAny(k, blockLocals)) {
        found = k
        return false
      }
    }
    return undefined
  })
  return found
}
