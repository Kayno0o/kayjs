import type * as t from '@babel/types'
import type { KayLibrary } from '../build/libraries'
import type { UiSource } from '../build/ui'
import type { StyleInfo } from '../build/ui-info'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import { findKayLibraries } from '../build/libraries'
import { classesOf, componentFile, componentsNamed, exported, forgetNames, isComponentName, keyOf, UI_FILE, uiOf } from '../build/ui'
import { appSpecifier, styleInfo, themeTokens, tokensNamedBy } from '../build/ui-info'
import { unwrapped } from '../compiler/object-literal'
import { isCrossSite } from './actions'

const HEADER = 'x-kay-dev'
const MAX_CLASSES = 4000
const WHITESPACE = /\s+/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/
const INDENT = /^[ \t]*/

const refused = (error: string, status = 400) => Response.json({ error }, { status })

function realOf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// The component a request names, by its path from the project's root: a `.kay` file of the project or of a library it uses, and one `src/ui.ts` can restyle.
async function componentOf(root: string, name: unknown): Promise<{ info: StyleInfo, libraries: KayLibrary[] } | Response> {
  if (typeof name !== 'string' || !name.endsWith('.kay'))
    return refused('file is the path of a .kay component')

  const path = resolve(root, name)
  const file = existsSync(path) ? realOf(path) : undefined

  if (file === undefined)
    return refused('no such component', 404)

  const libraries = await findKayLibraries(root)
  const within = (dir: string) => {
    const from = relative(realOf(dir), file)

    return from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from)
  }
  const info = within(root) || libraries.some(library => within(library.realDir)) ? styleInfo(file) : undefined

  return info === undefined ? refused('this file has no parts or recipe to restyle', 404) : { info, libraries }
}

// The key `src/ui.ts` names a component by: the entry already naming it, else its bare name when no other component bears it, else the specifier it would be imported with.
function keyFor(root: string, ui: UiSource | undefined, info: StyleInfo, libraries: KayLibrary[]): string {
  const known = ui?.components.findLast(component => componentFile(ui, component) === info.file)

  if (known !== undefined)
    return known.specifier

  const index: UiSource = ui ?? { file: join(root, UI_FILE), source: '', components: [], problems: [] }

  forgetNames(index)

  if (isComponentName(info.name) && componentsNamed(index, info.name).length === 1 && componentsNamed(index, info.name)[0] === info.file)
    return info.name

  for (const library of libraries) {
    for (const [specifier, file] of library.specifiers) {
      if (realOf(file) === info.file)
        return specifier
    }
  }

  return appSpecifier(root, info.file)
}

function literal(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

const keyText = (key: string) => isComponentName(key) ? key : literal(key)

interface Edit {
  at: number
  remove: number
  text: string
}

function indentOf(source: string, offset: number): string {
  return INDENT.exec(source.slice(source.lastIndexOf('\n', offset - 1) + 1))![0]
}

// The offset just past the comma closing `from`, looking through whitespace and comments up to `limit`, or undefined without one.
function commaAfter(source: string, from: number, limit: number, comments: readonly t.Comment[]): number | undefined {
  let at = from

  while (at < limit) {
    const comment = comments.find(c => c.start === at)

    if (comment !== undefined)
      at = comment.end!
    else if (source[at] === ',')
      return at + 1
    else if (source[at]!.trim() === '')
      at++
    else
      return undefined
  }

  return undefined
}

// Adds `property` as the last one of an object literal, in the indentation of the others.
function appendProperty(source: string, object: t.ObjectExpression, property: string, comments: readonly t.Comment[]): Edit {
  const last = object.properties.at(-1)
  const start = object.start!
  const inline = !source.slice(start, object.end!).includes('\n')

  if (last === undefined && inline) {
    // A block comment in the braces stays, the property goes after it.
    const kept = source.slice(start + 1, object.end! - 1).trim()
    const lead = kept === '' ? '' : `${kept} `

    return { at: start, remove: object.end! - start, text: `{ ${lead}${property} }` }
  }

  if (last === undefined) {
    const kept = source.slice(start + 1, object.end! - 1).trimEnd()

    // A comment inside the braces stays, the property goes below it.
    if (kept.trim() !== '')
      return { at: start + 1 + kept.length, remove: 0, text: `\n${indentOf(source, start)}  ${property},` }

    return { at: start, remove: object.end! - start, text: `{\n${indentOf(source, start)}  ${property},\n${indentOf(source, start)}}` }
  }

  const indent = indentOf(source, object.properties[0]!.start!)
  const commaEnd = commaAfter(source, last.end!, object.end! - 1, comments)
  const trailing = commaEnd === undefined ? null : commaEnd - last.end!

  if (inline)
    return trailing === null ? { at: last.end!, remove: 0, text: `, ${property}` } : { at: last.end! + trailing, remove: 0, text: ` ${property},` }

  const tail = source.slice(last.end!, object.end! - 1).trimEnd()
  const comment = trailing === null ? tail !== '' : `${tail.slice(0, trailing - 1)}${tail.slice(trailing)}`.trim() !== ''

  // Comments after the last property stay where they are, the new one goes below them.
  if (comment)
    return trailing === null ? { at: last.end!, remove: tail.length, text: `,${tail}\n${indent}${property}` } : { at: last.end! + tail.length, remove: 0, text: `\n${indent}${property},` }

  return trailing === null ? { at: last.end!, remove: 0, text: `,\n${indent}${property}` } : { at: last.end! + trailing, remove: 0, text: `\n${indent}${property},` }
}

const isLiteral = (node: t.Node) => classesOf(node) !== undefined

// The edit setting `part`'s classes in the source of `src/ui.ts`; a message when the file holds something it cannot edit in place.
function editFor(source: string, key: string, part: string, classes: string): Edit | string {
  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  }
  catch {
    return 'src/ui.ts does not parse'
  }

  const comments = ast.comments ?? []
  const root = exported(ast)
  const object = root === undefined ? undefined : unwrapped(root)

  if (object?.type !== 'ObjectExpression')
    return 'src/ui.ts has no `defineUi({ ... })` object to add to'

  const entries = object.properties.filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty')
  const quoted = literal(classes)
  const partText = `${keyText(part)}: ${quoted}`
  const entry = entries.find(property => keyOf(property) === key)

  if (entry === undefined)
    return appendProperty(source, object, `${keyText(key)}: { parts: { ${partText} } }`, comments)

  const value = unwrapped(entry.value)

  if (value.type !== 'ObjectExpression')
    return `the entry of ${key} is not an object literal`

  const parts = value.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyOf(property) === 'parts')

  if (parts === undefined)
    return appendProperty(source, value, `parts: { ${partText} }`, comments)

  const body = unwrapped(parts.value)

  if (isLiteral(body))
    return part === 'root' ? { at: body.start!, remove: body.end! - body.start!, text: quoted } : { at: body.start!, remove: body.end! - body.start!, text: `{ root: ${source.slice(body.start!, body.end!)}, ${partText} }` }

  if (body.type !== 'ObjectExpression')
    return `the parts of ${key} are not an object literal`

  const existing = body.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyOf(property) === part)

  if (existing === undefined)
    return appendProperty(source, body, partText, comments)

  const current = unwrapped(existing.value)

  return isLiteral(current) ? { at: current.start!, remove: current.end! - current.start!, text: quoted } : `the ${part} part of ${key} is not a string`
}

// What the Styles tab shows of the component a file holds: its parts with their recipe classes and what `src/ui.ts` sets over them, its variants, and the theme tokens its classes name.
export async function devUi(root: string, request: Request): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  const found = await componentOf(root, new URL(request.url).searchParams.get('file'))

  if (found instanceof Response)
    return found

  const { info, libraries } = found
  const ui = uiOf(root)
  const set = ui?.components.findLast(component => componentFile(ui, component) === info.file)?.entry
  const own = (part: string): string | undefined => {
    if (typeof set?.parts === 'string')
      return part === 'root' ? set.parts : undefined

    return set?.parts?.[part]
  }
  const parts = info.parts.map(part => ({ name: part.name, classes: part.classes, set: own(part.name) }))
  const tokens = tokensNamedBy(parts.map(part => `${part.classes} ${part.set ?? ''}`).join(' '), themeTokens(root))

  return Response.json({ name: info.name, key: keyFor(root, ui, info, libraries), recipe: info.recipe, exists: ui !== undefined, parts, variants: info.variants, tokens })
}

// Sets one part's classes in `src/ui.ts`, creating the file when the app has none.
export async function devUiWrite(root: string, request: Request): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  let body: { file?: unknown, part?: unknown, classes?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return refused('the request holds no JSON')
  }

  if (typeof body.part !== 'string' || typeof body.classes !== 'string')
    return refused('part and classes are texts')

  const classes = body.classes.replaceAll(WHITESPACE, ' ').trim()

  if (classes.length > MAX_CLASSES || CONTROL.test(classes))
    return refused('classes are one line of text')

  const found = await componentOf(root, body.file)

  if (found instanceof Response)
    return found

  const { info, libraries } = found
  const part = body.part

  if (!info.parts.some(candidate => candidate.name === part))
    return refused(`${info.name} has no part ${part}`, 404)

  const file = join(root, UI_FILE)
  const ui = uiOf(root)
  const key = keyFor(root, ui, info, libraries)

  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true })
    await Bun.write(file, `import { defineUi } from 'kay'\n\nexport default defineUi({\n  ${keyText(key)}: { parts: { ${keyText(part)}: ${literal(classes)} } },\n})\n`)

    return Response.json({ key, created: true })
  }

  const source = await Bun.file(file).text()
  const edit = editFor(source, key, part, classes)

  if (typeof edit === 'string')
    return refused(edit, 422)

  const written = source.slice(0, edit.at) + edit.text + source.slice(edit.at + edit.remove)

  try {
    parse(written, { sourceType: 'module', plugins: ['typescript'] })
  }
  catch {
    return refused('the edit would leave src/ui.ts unparsable, so it was not written', 422)
  }

  await Bun.write(file, written)

  return Response.json({ key, created: false })
}
