import type * as t from '@babel/types'
import { parse } from '@babel/parser'

interface Edit {
  start: number
  end: number
  text: string
}

// Nodes that wrap a value and are written back as that value.
const AFTER = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSInstantiationExpression'])
// Nodes that only exist in the types, whatever they hold.
const ERASED = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSIndexSignature', 'TSDeclareMethod'])
const NOT_CHILDREN = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments', 'extra'])

export class StripError extends Error {
  start: number

  constructor(message: string, start: number) {
    super(message)
    this.start = start
  }
}

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function nameOf(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value
}

class Stripper {
  private edits: Edit[] = []
  private exported: string[] = []

  run(code: string): string {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] })

    for (const statement of ast.program.body)
      this.visit(statement)

    let out = code

    for (const edit of this.edits.toSorted((a, b) => b.start - a.start))
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)

    return this.exported.length === 0 ? out : `${out}\nObject.assign(__exports, { ${this.exported.join(', ')} })\n`
  }

  private cut(start: number, end: number, text = ''): void {
    this.edits.push({ start, end, text })
  }

  private visit(node: t.Node): void {
    const { type } = node
    const start = node.start!
    const end = node.end!

    if (ERASED.has(type)) {
      this.cut(start, end)

      return
    }

    if (AFTER.has(type)) {
      const { expression } = node as t.TSAsExpression

      this.cut(expression.end!, end)
      this.visit(expression)

      return
    }

    if (type === 'TSTypeAssertion') {
      const { expression } = node as t.TSTypeAssertion

      this.cut(start, expression.start!)
      this.visit(expression)

      return
    }

    if (type === 'TSEnumDeclaration' || type === 'TSModuleDeclaration' || type === 'TSImportEqualsDeclaration' || type === 'TSExportAssignment')
      throw new StripError('The playground does not run TypeScript enums, namespaces or `import =`', start)

    if (type === 'ImportDeclaration') {
      this.importOf(node as t.ImportDeclaration)

      return
    }

    if (type === 'ExportNamedDeclaration') {
      this.exportOf(node as t.ExportNamedDeclaration)

      return
    }

    if (type === 'ExportDefaultDeclaration') {
      this.defaultOf(node as t.ExportDefaultDeclaration)

      return
    }

    if (type === 'ExportAllDeclaration')
      throw new StripError('The playground has no module to `export *` from', start)

    // `x?: T` and `let x!: T`: the marker sits right after the name, before the annotation.
    if (type === 'Identifier' && ((node as t.Identifier).optional || (node as { definite?: boolean }).definite))
      this.cut(start + (node as t.Identifier).name.length, start + (node as t.Identifier).name.length + 1)

    for (const [key, value] of Object.entries(node)) {
      if (NOT_CHILDREN.has(key))
        continue

      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item))
            this.visit(item)
        }
      }
      else if (isNode(value)) {
        this.visit(value)
      }
    }
  }

  private importOf(node: t.ImportDeclaration): void {
    if (node.importKind === 'type') {
      this.cut(node.start!, node.end!)

      return
    }

    const source = JSON.stringify(node.source.value)
    const named: string[] = []
    let namespace: string | undefined

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespace = specifier.local.name
      }
      else if (specifier.type === 'ImportDefaultSpecifier') {
        named.push(`default: ${specifier.local.name}`)
      }
      else if (specifier.importKind !== 'type') {
        const imported = nameOf(specifier.imported)

        named.push(imported === specifier.local.name ? imported : `${JSON.stringify(imported)}: ${specifier.local.name}`)
      }
    }

    const reads = [namespace === undefined ? '' : `const ${namespace} = __require(${source});`, named.length === 0 ? '' : `const { ${named.join(', ')} } = __require(${source});`]

    this.cut(node.start!, node.end!, reads.join(' ').trim() || `__require(${source});`)
  }

  private exportOf(node: t.ExportNamedDeclaration): void {
    if (node.exportKind === 'type') {
      this.cut(node.start!, node.end!)

      return
    }

    if (node.source)
      throw new StripError('The playground has no module to re-export from', node.start!)

    const { declaration } = node

    if (declaration) {
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === 'Identifier')
            this.exported.push(`${declarator.id.name}: ${declarator.id.name}`)
        }
      }
      else if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
        this.exported.push(`${declaration.id.name}: ${declaration.id.name}`)
      }

      this.cut(node.start!, declaration.start!)
      this.visit(declaration)

      return
    }

    for (const specifier of node.specifiers) {
      if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type')
        this.exported.push(`${JSON.stringify(nameOf(specifier.exported))}: ${specifier.local.name}`)
    }

    this.cut(node.start!, node.end!)
  }

  private defaultOf(node: t.ExportDefaultDeclaration): void {
    const { declaration } = node

    if ((declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id) {
      this.cut(node.start!, declaration.start!)
      this.exported.push(`default: ${declaration.id.name}`)
    }
    else {
      this.cut(node.start!, declaration.start!, '__exports.default = ')
    }

    this.visit(declaration)
  }
}

// TypeScript the compiler wrote, as plain JavaScript that reads its imports from `__require` and puts its exports on `__exports`: the playground runs it in a frame with `new Function`, so a type-stripping tool would only be weight. Types are cut out of the text and nothing is reprinted, so what runs is what the compiler wrote.
export function stripTypes(code: string): string {
  return new Stripper().run(code)
}
