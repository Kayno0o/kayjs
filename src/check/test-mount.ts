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
    const namespaces = new Set<string>()

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
        if (specifier.type === 'ImportNamespaceSpecifier') {
          namespaces.add(specifier.local.name)
        }
        else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && nameOf(specifier.imported) === 'mount') {
          // Aliased to the name it had, so the call sites stay as written.
          report(specifier, { start: specifier.start!, end: specifier.end!, text: `mountComponent as ${specifier.local.name}` })
        }
      }
    }

    // `await import('kay/test')` is read like the static import: bound to a name it is a namespace, destructured its `mount` is renamed in the pattern, and a member of it directly is renamed.
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isTestImport(node.init))
        namespaces.add(node.id.name)
    })
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && isTestImport(node.init)) {
        for (const property of node.id.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || nameOf(property.key) !== 'mount')
            continue

          // A shorthand `{ mount }` keeps its local name, so the call sites stay as written.
          report(property.key, { start: property.key.start!, end: property.key.end!, text: property.shorthand ? 'mountComponent: mount' : 'mountComponent' })
        }
      }
      else if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'mount' && (isTestImport(node.object) || (node.object.type === 'Identifier' && namespaces.has(node.object.name)))) {
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

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walk(child as t.Node, visit)
    }
  }
}
