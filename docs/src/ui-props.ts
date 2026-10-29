import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
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
const NUMBER = /^\d+(?:\.\d+)?$/

const options: ts.CompilerOptions = { strict: true, exactOptionalPropertyTypes: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, skipLibCheck: true, noEmit: true, types: [] }

// What a cache file holds: the key of the components' scripts and of this module, the files the program read (or found missing) with a hash of each, and the props.
interface PropsCache {
  key: string
  seen: [string, string | null][]
  props: [string, Prop[]][]
}

// The props each component declares itself, read with the checker from its `props<...>()` type in one program for all of them: attributes a component takes from an HTML element's type are left out, as it spreads those onto its root.
// With a `cache` file, the program is skipped while the scripts, this module, TypeScript's version and every file the last program read or looked for are as they were.
export function propsOf(files: string[], cache?: string): Map<string, Prop[]> {
  const scripts = files.map(file => scriptOf(readFileSync(file, 'utf8')))
  const key = cache === undefined ? '' : Bun.hash(JSON.stringify([ts.version, readFileSync(import.meta.path, 'utf8'), files, scripts])).toString(36)
  const kept = cache === undefined ? undefined : readCache(cache)

  if (kept?.key === key && kept.seen.every(([name, hash]) => hashOf(name) === hash))
    return new Map(kept.props)

  const seen = new Map<string, string | null>()
  const { program, checker } = programOf(files, scripts, seen)
  const props = new Map(files.map(file => [file, declaredProps(checker, program.getSourceFile(`${file}.ts`)!)]))

  if (cache !== undefined)
    writeCache(cache, { key, seen: [...seen.keys()].map(name => [name, hashOf(name)]), props: [...props] })

  return props
}

function hashOf(file: string): string | null {
  try {
    return Bun.hash(readFileSync(file)).toString(36)
  }
  catch {
    return null
  }
}

function readCache(file: string): PropsCache | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PropsCache
  }
  catch {
    return undefined
  }
}

// Written aside and renamed, so a build running beside this one never reads half of it; a read-only disk only loses the cache.
function writeCache(file: string, cache: PropsCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.${process.pid}`, JSON.stringify(cache))
    renameSync(`${file}.${process.pid}`, file)
  }
  catch {}
}

// The variants a component declares in its `props<>` as well as in its recipe, by file: a variant is declared once, in the recipe, and the props take it from there.
export function repeatedVariants(files: string[]): Map<string, string[]> {
  const { program, checker } = programOf(files, files.map(file => scriptOf(readFileSync(file, 'utf8'))))

  return new Map(files.map((file) => {
    const source = program.getSourceFile(`${file}.ts`)!
    const declared = new Set(declaredProps(checker, source, false, file => !program.isSourceFileDefaultLibrary(file) && !file.fileName.includes('/node_modules/')).map(prop => prop.name))

    return [file, variantsOf(source).map(variant => variant.name).filter(name => declared.has(name))]
  }))
}

// `seen` collects every file outside the components the program reads or looks for, which decide the props as much as the components do.
function programOf(files: string[], scripts: string[], seen = new Map<string, string | null>()) {
  const sources = new Map(files.map((file, index) => [`${file}.ts`, scripts[index]!]))
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  const note = (name: string) => {
    if (!sources.has(name))
      seen.set(name, null)
  }

  host.getSourceFile = (name, language, ...rest) => {
    const text = sources.get(name)

    note(name)

    return text === undefined ? getSourceFile(name, language, ...rest) : ts.createSourceFile(name, text, language, true)
  }
  host.fileExists = (name) => {
    note(name)

    return sources.has(name) || ts.sys.fileExists(name)
  }
  host.readFile = (name) => {
    note(name)

    return sources.get(name) ?? ts.sys.readFile(name)
  }

  const program = ts.createProgram([...sources.keys()], options, host)

  return { program, checker: program.getTypeChecker() }
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

// `withVariants` adds the recipe's; `declaredIn` says which files a prop may be declared in, the component's own by default.
function declaredProps(checker: ts.TypeChecker, source: ts.SourceFile, withVariants = true, declaredIn = (file: ts.SourceFile) => file === source): Prop[] {
  const call = find(source)

  if (call === undefined)
    return withVariants ? variantsOf(source) : []

  const declared = checker.getTypeFromTypeNode(call.typeArguments![0]!)
  const defaults = defaultsOf(call)
  const props = new Map<string, Prop & { types: Set<string> }>()

  // A union of shapes, such as a button or a link, lists each prop once with every type it takes.
  for (const type of declared.isUnion() ? declared.types : [declared]) {
    for (const symbol of checker.getPropertiesOfType(type)) {
      // An intersection with an element's attributes, such as a link's `href` narrowed to a string, declares the prop both there and here.
      const declaration = symbol.declarations?.find(candidate => declaredIn(candidate.getSourceFile()))

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

  const listed = [...props.values()].map(({ types, ...prop }) => {
    const shown = [...types].filter(type => type !== 'undefined' || types.size === 1)

    return { ...prop, type: shown.length === 1 ? unwrap(shown[0]!) : shown.join(' | ') }
  })

  return withVariants ? [...variantsOf(source, defaults).filter(variant => !props.has(variant.name)), ...listed] : listed
}

// The variants of the component's recipe as props, declared there once: each value it names, the default it destructures or else the recipe's own, and the comment above the variant.
function variantsOf(source: ts.SourceFile, defaults = new Map<string, string>()): Prop[] {
  const config = recipeConfig(source)
  const variants = config === undefined ? undefined : objectOf(config, 'variants')

  if (config === undefined || variants === undefined)
    return []

  const recipeDefaults = objectOf(config, 'defaults')

  return variants.properties.flatMap((variant) => {
    const name = nameOf(variant.name)
    const values = ts.isPropertyAssignment(variant) && ts.isObjectLiteralExpression(variant.initializer) ? variant.initializer.properties.map(value => value.name === undefined ? undefined : nameOf(value.name)) : []

    if (name === undefined || values.includes(undefined))
      return []

    const written = values as string[]
    const type = written.length === 2 && written.includes('true') && written.includes('false') ? 'boolean' : written.map(value => NUMBER.test(value) ? value : `"${value}"`).join(' | ')
    const fallback = recipeDefaults?.properties.find(candidate => nameOf(candidate.name) === name)

    return [{ name, type, optional: true, default: defaults.get(name) ?? (fallback !== undefined && ts.isPropertyAssignment(fallback) ? fallback.initializer.getText() : undefined), comment: commentOf(variant) }]
  })
}

// The object `recipe({ ... })` is called with, wherever the component's script declares it.
function recipeConfig(node: ts.Node): ts.ObjectLiteralExpression | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'recipe') {
    const [config] = node.arguments

    return config !== undefined && ts.isObjectLiteralExpression(config) ? config : undefined
  }

  return ts.forEachChild(node, recipeConfig)
}

function objectOf(config: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralExpression | undefined {
  const property = config.properties.find(candidate => ts.isPropertyAssignment(candidate) && nameOf(candidate.name) === key)

  return property !== undefined && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer) ? property.initializer : undefined
}

function nameOf(name: ts.PropertyName | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? name.text : undefined
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
    if (char === '(')
      depth++
    else if (char === ')')
      depth--

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
