import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const TEST_FILE = /(?<!\.d)\.tsx?$/
const TEST_MODULE = 'kay/test'

// The `mount` that `kay/test` exported before 1.52 renamed it `mountComponent`, as an import of it or a member of a namespace import is written.
// Only the project's own TypeScript files are read, and only those naming `kay/test`.
export async function testMounts(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-test-mount', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, TEST_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(TEST_MODULE))
      continue

    let ast: t.File

    try {
      ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
    }
    catch {
      continue
    }

    const report = (node: t.Node, edit: { start: number, end: number, text: string }) => {
      found.push({
        file,
        ...positionAt(source, node.start!),
        end: node.end!,
        message: '`mount` from `kay/test` is now `mountComponent`: `kay/mount` has a `mount` of its own, which this one is not',
        help: 'import `mountComponent`',
        code: 'deprecated-test-mount',
        severity: level === 'warn' ? 'warning' : 'error',
        fixes: [{ title: 'Use mountComponent', edits: [edit], safe: true }],
      })
    }

    for (const statement of ast.program.body) {
      if (statement.type === 'ExportNamedDeclaration' && statement.source?.value === TEST_MODULE && statement.exportKind !== 'type') {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type' && nameOf(specifier.local) === 'mount')
            report(specifier, { start: specifier.start!, end: specifier.end!, text: `mountComponent as ${nameOf(specifier.exported)}` })
        }
      }

      if (statement.type !== 'ImportDeclaration' || statement.source.value !== TEST_MODULE || statement.importKind === 'type')
        continue

      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && nameOf(specifier.imported) === 'mount') {
          // Aliased to the name it had, so the call sites stay as written.
          report(specifier, { start: specifier.start!, end: specifier.end!, text: `mountComponent as ${specifier.local.name}` })
        }
      }
    }

    // `await import('kay/test')` is read like the static import: bound to a name it is a namespace, destructured its `mount` is renamed in the pattern, and a member of it directly is renamed.
    // A namespace is the binding the import made, so a same-named variable of another scope is left alone.
    walkScoped(ast.program, [], (node, scopes) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isTestImport(node.init)) {
        for (const property of node.id.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || nameOf(property.key) !== 'mount')
            continue

          // A shorthand `{ mount }` keeps its local name, so the call sites stay as written.
          report(property.key, { start: property.key.start!, end: property.key.end!, text: property.shorthand ? 'mountComponent: mount' : 'mountComponent' })
        }
      }
      else if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'mount' && (isTestImport(node.object) || (node.object.type === 'Identifier' && isNamespace(node.object.name, scopes)))) {
        report(node.property, { start: node.property.start!, end: node.property.end!, text: 'mountComponent' })
      }
    })
  }

  return found
}

function nameOf(node: t.Identifier | t.StringLiteral | t.Node): string | undefined {
  if (node.type === 'Identifier')
    return node.name

  return node.type === 'StringLiteral' ? node.value : undefined
}

// `import('kay/test')`, awaited or not.
function isTestImport(node: t.Node | null | undefined): boolean {
  const call = node?.type === 'AwaitExpression' ? node.argument : node

  return call?.type === 'CallExpression' && call.callee.type === 'Import' && call.arguments[0]?.type === 'StringLiteral' && call.arguments[0].value === TEST_MODULE
}

// A scope maps each name it declares to whether it is bound to the `kay/test` namespace.
type Scope = Map<string, boolean>

function isNamespace(name: string, scopes: Scope[]): boolean {
  for (let index = scopes.length - 1; index >= 0; index--) {
    const bound = scopes[index]!.get(name)

    if (bound !== undefined)
      return bound
  }

  return false
}

function patternNames(node: t.Node | null | undefined, into: string[] = []): string[] {
  if (node?.type === 'Identifier') {
    into.push(node.name)
  }
  else if (node?.type === 'ObjectPattern') {
    for (const property of node.properties) {
      patternNames(property.type === 'RestElement' ? property.argument : property.value, into)
    }
  }
  else if (node?.type === 'ArrayPattern') {
    for (const element of node.elements) {
      patternNames(element, into)
    }
  }
  else if (node?.type === 'RestElement') {
    patternNames(node.argument, into)
  }
  else if (node?.type === 'AssignmentPattern') {
    patternNames(node.left, into)
  }
  else if (node?.type === 'TSParameterProperty') {
    patternNames(node.parameter, into)
  }

  return into
}

function declare(scope: Scope, node: t.Node | null | undefined, vars: boolean): void {
  if (node === null || node === undefined)
    return

  if (node.type === 'VariableDeclaration') {
    // A `var` belongs to the function, whichever block it is written in.
    if ((node.kind === 'var') !== vars)
      return

    for (const declarator of node.declarations) {
      const namespace = declarator.id.type === 'Identifier' && isTestImport(declarator.init)

      for (const name of patternNames(declarator.id))
        scope.set(name, namespace)
    }
  }
  else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && !vars && node.id) {
    scope.set(node.id.name, false)
  }
  else if (node.type === 'ImportDeclaration' && !vars) {
    for (const specifier of node.specifiers)
      scope.set(specifier.local.name, specifier.type === 'ImportNamespaceSpecifier' && node.source.value === TEST_MODULE && node.importKind !== 'type')
  }
  else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration) {
    declare(scope, node.declaration, vars)
  }
}

// What a `var` below it belongs to, so it is not hoisted out of it: a function, a method of a class or an object, a static block and a namespace.
const SCOPE_BOUNDARY = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'StaticBlock', 'TSModuleBlock'])

// Every `var` below a function body, the nested functions left out.
function declareVars(scope: Scope, node: t.Node): void {
  declare(scope, node, true)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string' && !SCOPE_BOUNDARY.has((child as t.Node).type))
        declareVars(scope, child as t.Node)
    }
  }
}

function scopeOf(node: t.Node): Scope | undefined {
  const scope: Scope = new Map()

  if (node.type === 'Program') {
    declareVars(scope, node)
    for (const statement of node.body) {
      declare(scope, statement, false)
    }
  }
  else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod') {
    for (const param of node.params) {
      for (const name of patternNames(param)) {
        scope.set(name, false)
      }
    }

    if (node.type === 'FunctionExpression' && node.id)
      scope.set(node.id.name, false)

    declareVars(scope, node.body)

    if (node.body.type === 'BlockStatement') {
      for (const statement of node.body.body) {
        declare(scope, statement, false)
      }
    }
  }
  else if (node.type === 'BlockStatement' || node.type === 'StaticBlock' || node.type === 'TSModuleBlock') {
    // A static block and a namespace own their `var`s as a function does.
    if (node.type !== 'BlockStatement')
      declareVars(scope, node)

    for (const statement of node.body) {
      declare(scope, statement, false)
    }
  }
  else if (node.type === 'SwitchStatement') {
    for (const switchCase of node.cases) {
      for (const statement of switchCase.consequent) {
        declare(scope, statement, false)
      }
    }
  }
  else if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    declare(scope, node.type === 'ForStatement' ? node.init : node.left, false)
  }
  else if (node.type === 'CatchClause') {
    for (const name of patternNames(node.param)) {
      scope.set(name, false)
    }
  }
  else {
    return undefined
  }

  return scope
}

function walkScoped(node: t.Node, scopes: Scope[], visit: (node: t.Node, scopes: Scope[]) => void): void {
  const scope = scopeOf(node)
  const inner = scope === undefined ? scopes : [...scopes, scope]

  visit(node, inner)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walkScoped(child as t.Node, inner, visit)
    }
  }
}
