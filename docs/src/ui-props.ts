import { readFileSync } from 'node:fs'
import ts from 'typescript'

export interface Prop {
  name: string
  type: string
  optional: boolean
  default?: string | undefined
  comment?: string | undefined
}

const FENCE = /^---(?<server> server)?(?:\s*<(?<generics>.*)>)?\s*$/
const COMMENT_MARK = /^\/\/\s?/gm
const UNDEFINED = / \| undefined$/

const options: ts.CompilerOptions = { strict: true, exactOptionalPropertyTypes: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, skipLibCheck: true, noEmit: true, types: [] }

// The props each component declares itself, read with the checker from its `props<...>()` type in one program for all of them: attributes a component takes from an HTML element's type are left out, as it spreads those onto its root.
export function propsOf(files: string[]): Map<string, Prop[]> {
  const sources = new Map(files.map(file => [`${file}.ts`, scriptOf(readFileSync(file, 'utf8'))]))
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)

  host.getSourceFile = (name, language, ...rest) => {
    const text = sources.get(name)

    return text === undefined ? getSourceFile(name, language, ...rest) : ts.createSourceFile(name, text, language, true)
  }
  host.fileExists = name => sources.has(name) || ts.sys.fileExists(name)
  host.readFile = name => sources.get(name) ?? ts.sys.readFile(name)

  const program = ts.createProgram([...sources.keys()], options, host)
  const checker = program.getTypeChecker()

  return new Map(files.map(file => [file, declaredProps(checker, program.getSourceFile(`${file}.ts`)!)]))
}

// The component script as TypeScript: its client fence, `props` declared, and the type parameters a generic component's fence line takes declared as their constraints.
function scriptOf(source: string): string {
  const lines = source.split('\n')
  let open: { line: number, server: boolean, generics: string | undefined } | undefined

  for (const [index, line] of lines.entries()) {
    const fence = FENCE.exec(line)

    if (fence === null)
      continue

    if (open === undefined)
      open = { line: index, server: fence.groups?.server !== undefined, generics: fence.groups?.generics }
    else if (open.server)
      open = undefined
    else
      return `declare function props<T>(): T\n${typeParameters(open.generics)}\n${lines.slice(open.line + 1, index).join('\n')}`
  }

  return ''
}

// `<Row extends { id: string }>` becomes `interface Row {}`, for the props table to name `Row` rather than spell out its constraint.
function typeParameters(generics: string | undefined): string {
  if (generics === undefined)
    return ''

  const declared = ts.createSourceFile('generics.ts', `function f<${generics}>() {}`, ts.ScriptTarget.ESNext, true).statements[0] as ts.FunctionDeclaration

  return (declared.typeParameters ?? []).map(parameter => `interface ${parameter.name.text} {}`).join('\n')
}

function declaredProps(checker: ts.TypeChecker, source: ts.SourceFile): Prop[] {
  const call = find(source)

  if (call === undefined)
    return []

  const declared = checker.getTypeFromTypeNode(call.typeArguments![0]!)
  const defaults = defaultsOf(call)
  const props = new Map<string, Prop & { types: Set<string> }>()

  // A union of shapes, such as a button or a link, lists each prop once with every type it takes.
  for (const type of declared.isUnion() ? declared.types : [declared]) {
    for (const symbol of checker.getPropertiesOfType(type)) {
      // An intersection with an element's attributes, such as a link's `href` narrowed to a string, declares the prop both there and here.
      const declaration = symbol.declarations?.find(candidate => candidate.getSourceFile() === source)

      if (declaration === undefined)
        continue

      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0
      const written = checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, call), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope)
      const prop = props.get(symbol.name) ?? { name: symbol.name, type: '', types: new Set<string>(), optional, default: defaults.get(symbol.name), comment: commentOf(declaration) }

      prop.optional ||= optional
      prop.comment ??= commentOf(declaration)

      for (const member of members(written.replace(UNDEFINED, '')))
        prop.types.add(member)

      props.set(symbol.name, prop)
    }
  }

  return [...props.values()].map(({ types, ...prop }) => {
    const shown = [...types].filter(type => type !== 'undefined' || types.size === 1)

    return { ...prop, type: shown.length === 1 ? unwrap(shown[0]!) : shown.join(' | ') }
  })
}

// The members of a union as printed, split at the top level only, so two shapes both taking `string` list it once.
function members(type: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (const [index, char] of [...type].entries()) {
    if ('([{<'.includes(char)) {
      depth++
    }
    else if (')]}'.includes(char) || (char === '>' && type[index - 1] !== '=')) {
      depth--
    }
    else if (char === '|' && depth === 0) {
      parts.push(type.slice(start, index).trim())
      start = index + 1
    }
  }

  return [...parts, type.slice(start).trim()]
}

// `((value: string) => void)`, as an optional function prints once ` | undefined` is gone, loses its outer parens.
function unwrap(type: string): string {
  if (!type.startsWith('(') || !type.endsWith(')'))
    return type

  let depth = 0

  for (const [index, char] of [...type].entries()) {
    depth += char === '(' ? 1 : char === ')' ? -1 : 0

    if (depth === 0 && index < type.length - 1)
      return type
  }

  return type.slice(1, -1)
}

function find(node: ts.Node): ts.CallExpression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'props' && node.typeArguments?.length === 1)
    return node

  return ts.forEachChild(node, find)
}

// `const { variant = 'default' } = props<...>()` gives `variant` its default.
function defaultsOf(call: ts.CallExpression): Map<string, string> {
  const defaults = new Map<string, string>()
  const declaration = call.parent

  if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name))
    return defaults

  for (const element of declaration.name.elements) {
    const name = element.propertyName ?? element.name

    if (element.initializer !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)))
      defaults.set(name.text, element.initializer.getText())
  }

  return defaults
}

function commentOf(declaration: ts.Declaration): string | undefined {
  const text = declaration.getSourceFile().text
  const ranges = ts.getLeadingCommentRanges(text, declaration.pos) ?? []
  const comment = ranges.map(range => text.slice(range.pos, range.end).replace(COMMENT_MARK, '').trim()).join(' ')

  return comment === '' ? undefined : comment
}
