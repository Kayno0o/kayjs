import type * as t from '@babel/types'
import type { Imports } from './markup'
import { parse } from '@babel/parser'
import { eachNode } from '../compiler/each-node'
import { formatKay } from '../compiler/format'
import { MarkupError, translateMarkup } from './markup'

// `kay migrate astro`: an `.astro` file's frontmatter becomes a fence, its markup the indented template. What has no kay counterpart, or is not written the usual way, stays in the output commented out under a `// kay migrate:` line and is listed, never dropped.

export type Role = 'page' | 'component'

export interface Note {
  line: number
  message: string
}

export interface MigratedFile {
  code: string
  notes: Note[]
  // The `lang` a layout's `html` gives as text, which kay sets once in kay.config.ts.
  lang?: { line: number, value: string } | undefined
  // The Fontsource stylesheets the file imported, which kay serves through `fonts` in kay.config.ts instead.
  fonts: FontImport[]
}

export interface FontImport {
  line: number
  // The package, `@fontsource/montserrat`.
  fontsource: string
  // Undefined for a variable font, whose one file spans every weight.
  weight: number | undefined
  style: 'normal' | 'italic'
}

export interface MigrateOptions {
  role: Role
  // The `.kay` specifier an import of an `.astro` file becomes, relative to the new file, or undefined to keep it.
  rewriteImport: (specifier: string) => string | undefined
}

const FRONTMATTER = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const OTHER_FRAMEWORK = /\.(?:svelte|vue|jsx|tsx)$/
const ASTRO_ICON = /^astro-icon(?:\/.*)?$/
// `@fontsource/montserrat/400.css`, `@fontsource/montserrat/latin-400-italic.css`, `@fontsource-variable/inter/wght-italic.css` or the package alone.
const FONTSOURCE = /^(@fontsource(?:-variable)?\/[^/]+)(?:\/(.+?)(?:\.css)?)?$/
const FONT_WEIGHT = /^(?:[a-z][a-z-]*-)?(\d{3})(?:-(italic|normal))?$/
const FONT_VARIABLE = /^(?:[a-z][a-z-]*-)?(?:index|variable|wght|opsz|wdth|slnt|full)(?:-(italic|normal))?$/
const RAW_QUERY = /\?raw$/

interface Edit {
  start: number
  end: number
  text: string
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

function applyEdits(text: string, edits: Edit[]): string {
  let result = text

  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)

  return result
}

export function migrateAstro(source: string, options: MigrateOptions): MigratedFile {
  const notes: Note[] = []
  const match = FRONTMATTER.exec(source)
  const frontmatter = match?.[1] ?? ''
  // The template's first line in the file, for the lines notes give.
  const templateStart = match ? match[0].length : 0
  const templateLine = lineAt(source, templateStart)
  const imports: Imports = { image: new Set(), router: new Set(), kay: new Set(), kayTypes: new Set(), icon: new Set(), icons: new Map() }
  const fonts: FontImport[] = []
  const script = migrateFrontmatter(frontmatter, options, imports, fonts, (line, message) => notes.push({ line: line + 1, message }))
  let lang: MigratedFile['lang']
  const template = migrateTemplate(source.slice(templateStart), options, imports, (line, message) => notes.push({ line: line + templateLine - 1, message }), (line, value) => lang = { line: line + templateLine - 1, value })
  const iconImports = [...imports.icons].toSorted(([a], [b]) => a.localeCompare(b)).map(([name, specifier]) => `import ${name} from '${specifier}'\n`).join('')
  const kayImport = [...imports.kayTypes.size > 0 ? [`import type { ${[...imports.kayTypes].toSorted().join(', ')} } from 'kay'\n`] : [], ...imports.kay.size > 0 ? [`import { ${[...imports.kay].toSorted().join(', ')} } from 'kay'\n`] : [], iconImports].join('')
  const fenced = `${kayImport}${script.trim()}`.trim()
  const fence = fenced === '' ? '' : `${options.role === 'page' ? '--- server' : '---'}\n${fenced}\n---\n`
  const code = `${fence}${template}`
  const formatted = formatKay(code)

  if (formatted.diagnostics.length > 0)
    notes.push({ line: 1, message: `the translation does not parse as kay (${formatted.diagnostics[0]!.message}), so it is left as written; fix it by hand` })

  return { code: formatted.diagnostics.length > 0 ? code : formatted.code, notes: notes.toSorted((a, b) => a.line - b.line), lang, fonts }
}

function migrateTemplate(markup: string, options: MigrateOptions, imports: Imports, note: (line: number, message: string) => void, lang: (line: number, value: string) => void): string {
  const expression = (node: t.Node, code: string) => applyEdits(code, astroEdits(node, code, node.start!, options.role, 'template', note))

  try {
    return translateMarkup(markup, { mode: 'astro', note, lang, expression }, imports)
  }
  catch (error) {
    if (!(error instanceof MarkupError))
      throw error

    note(1, `the markup does not parse as Astro markup kay reads (${error.message}): kept as written, commented out`)

    return `// kay migrate: the markup below was not translated\n${markup.split('\n').map(line => `  ${line}`).join('\n')}\n`
  }
}

function migrateFrontmatter(code: string, options: MigrateOptions, imports: Imports, fonts: FontImport[], note: (line: number, message: string) => void): string {
  if (code.trim() === '')
    return ''

  let ast: t.File

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true })
  }
  catch (error) {
    note(0, `the frontmatter does not parse (${error instanceof Error ? error.message : String(error)}): kept as written`)

    return code
  }

  const edits: Edit[] = []
  const lineOf = (node: t.Node) => node.loc!.start.line
  const hasProps = ast.program.body.some(statement => (statement.type === 'TSInterfaceDeclaration' || statement.type === 'TSTypeAliasDeclaration') && statement.id.name === 'Props')
  let imageMetadata: string | undefined
  let htmlAttributes: string | undefined

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      const from = statement.source.value
      const remove = () => edits.push({ start: statement.start!, end: statement.end!, text: '' })

      if (from === 'astro:assets') {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'Image')
            imports.image.add(specifier.local.name)
          else
            note(lineOf(specifier), `\`${specifier.local.name}\` from astro:assets has no kay counterpart: an imported image is its URL, \`img(src={photo})\`, sized by kay`)
        }

        remove()
      }
      else if (from === 'astro:transitions') {
        for (const specifier of statement.specifiers)
          imports.router.add(specifier.local.name)

        remove()
      }
      else if (from === 'astro' || from === 'astro/types') {
        for (const specifier of statement.specifiers) {
          const imported = specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' ? specifier.imported.name : undefined

          if (imported === 'ImageMetadata')
            imageMetadata = specifier.local.name
          else if (imported === 'HTMLAttributes')
            htmlAttributes = specifier.local.name
          else
            note(lineOf(specifier), `\`${specifier.local.name}\` from ${from} has no kay counterpart`)
        }

        remove()
      }
      else if (ASTRO_ICON.test(from)) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'Icon')
            imports.icon.add(specifier.local.name)
          else
            note(lineOf(specifier), `\`${specifier.local.name}\` from ${from} has no kay counterpart: import the svg file, or the icon from \`@iconify-json/<prefix>\` as \`~icons/<prefix>/<name>\``)
        }

        remove()
      }
      else if (FONTSOURCE.test(from) && statement.specifiers.length === 0) {
        const font = fontOf(from, lineOf(statement))

        if (font) {
          fonts.push(font)
          remove()
        }
        else {
          note(lineOf(statement), `${from} is a stylesheet kay does not read: serve the font with \`fonts: [{ fontsource: '<package>' }]\` in kay.config.ts, which declares its faces without inlining every file into the page stylesheet`)
        }
      }
      else if (from.startsWith('astro:')) {
        note(lineOf(statement), `${from} has no kay counterpart${from === 'astro:content' ? ': a content collection is read with `collection` from `kay/content` (see Content collections)' : ''}`)
      }
      else if (from.endsWith('.astro')) {
        const target = options.rewriteImport(from)

        if (target === undefined)
          note(lineOf(statement), `${from} is no .astro file of the project kay migrate found: point the import at the .kay file`)
        else
          edits.push({ start: statement.source.start!, end: statement.source.end!, text: `'${target}'` })
      }
      else if (OTHER_FRAMEWORK.test(from)) {
        note(lineOf(statement), `${from} is another framework's component: rewrite it as a .kay island`)
      }
      else if (RAW_QUERY.test(from) && (statement.attributes?.length ?? 0) === 0) {
        // `?raw` is Vite's; Bun reads a file's text through an import attribute.
        edits.push({ start: statement.source.start!, end: statement.end!, text: `'${from.replace(RAW_QUERY, '')}' with { type: 'text' }` })
      }
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.declaration?.type === 'FunctionDeclaration' && statement.declaration.id?.name === 'getStaticPaths') {
      note(lineOf(statement), 'getStaticPaths: list the params in `export const page = { prerender: [...] }` instead (see Prerendering); commented out')
      edits.push({ start: statement.start!, end: statement.end!, text: code.slice(statement.start!, statement.end!).split('\n').map(line => `// ${line}`).join('\n') })
    }
  }

  // `ImageMetadata` is what an imported image is in Astro; in kay it is its URL.
  // The imports are removed whole, so the walks leave them out.
  const statements = ast.program.body.filter(statement => statement.type !== 'ImportDeclaration')

  const aliased = new Set<string>()

  for (const statement of statements) {
    eachNode(statement, (node) => {
      if (imageMetadata !== undefined && node.type === 'Identifier' && node.name === imageMetadata)
        edits.push({ start: node.start!, end: node.end!, text: 'string' })

      // `HTMLAttributes<'svg'>`, the attributes of an element, is kay's `JSX.IntrinsicElements['svg']`.
      if (htmlAttributes !== undefined && node.type === 'TSTypeReference' && node.typeName.type === 'Identifier' && node.typeName.name === htmlAttributes) {
        const [element] = node.typeParameters?.params ?? []

        if (element?.type === 'TSLiteralType' && element.literal.type === 'StringLiteral') {
          edits.push({ start: node.start!, end: node.end!, text: `JSX.IntrinsicElements['${element.literal.value}']` })
          imports.kayTypes.add('JSX')
        }
        else {
          note(lineOf(node), `${htmlAttributes} without an element name has no kay counterpart`)
        }

        return false
      }

      // An interface extends a name only, so the attributes get one: `interface Props extends SvgAttributes`.
      if (htmlAttributes !== undefined && node.type === 'TSExpressionWithTypeArguments' && node.expression.type === 'Identifier' && node.expression.name === htmlAttributes) {
        const [element] = node.typeParameters?.params ?? []

        if (element?.type === 'TSLiteralType' && element.literal.type === 'StringLiteral') {
          const tag = element.literal.value
          const name = `${tag[0]!.toUpperCase()}${tag.slice(1)}Attributes`

          edits.push({ start: node.start!, end: node.end!, text: name })
          imports.kayTypes.add('JSX')

          if (!aliased.has(name)) {
            aliased.add(name)
            edits.push({ start: statement.start!, end: statement.start!, text: `type ${name} = JSX.IntrinsicElements['${tag}']\n\n` })
          }
        }
        else {
          note(lineOf(node), `${htmlAttributes} without an element name has no kay counterpart`)
        }

        return false
      }

      return true
    })

    edits.push(...astroEdits(statement, code, 0, options.role, hasProps ? 'typed' : 'untyped', note))

    // Astro awaits in any component, kay in the server fence of a page or a layout only.
    if (options.role === 'component') {
      eachNode(statement, (node) => {
        if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
          note(lineOf(node), 'a component renders synchronously: load this in the page\'s server fence and pass it as a prop')

        return !node.type.includes('Function') && node.type !== 'AwaitExpression'
      })
    }
  }

  return applyEdits(code, edits)
}

// The `Astro.*` reads under `node`, as kay reads them: `Astro.props` through `props<Props>()`, which the template cannot call, a page's request through `ctx`.
function astroEdits(node: t.Node, code: string, offset: number, role: Role, props: 'typed' | 'untyped' | 'template', note: (line: number, message: string) => void): Edit[] {
  const edits: Edit[] = []
  const at = (inner: t.Node, text: string) => edits.push({ start: inner.start! - offset, end: inner.end! - offset, text })
  const page = role === 'page'

  eachNode(node, (inner) => {
    if (inner.type === 'MemberExpression' && isMetaEnv(inner.object)) {
      note(inner.loc!.start.line, `import.meta.env.${inner.property.type === 'Identifier' ? inner.property.name : '...'} is Vite's: declare the variable in a \`defineEnv\` schema from \`kay/server\` and read it from there (see Environment variables), or in \`publicEnv\` for an island`)

      return false
    }

    // `return Astro.redirect('/login')` ends the frontmatter; `ctx.redirect` stops the render by itself.
    if (inner.type === 'ReturnStatement' && inner.argument?.type === 'CallExpression' && isAstro(inner.argument.callee, 'redirect') && page) {
      at(inner, code.slice(inner.argument.start! - offset, inner.argument.end! - offset).replace('Astro.redirect', 'ctx.redirect'))

      return false
    }

    if (inner.type !== 'MemberExpression' || inner.object.type !== 'Identifier' || inner.object.name !== 'Astro' || inner.property.type !== 'Identifier')
      return true

    const name = inner.property.name
    const line = inner.loc!.start.line

    if (name === 'props' && props === 'template') {
      note(line, 'Astro.props in the markup: destructure the prop in the fence, `const { title } = props<Props>()`, and read it by its name')
    }
    else if (name === 'props') {
      at(inner, props === 'typed' ? 'props<Props>()' : 'props<Record<string, unknown>>()')

      if (props === 'untyped')
        note(line, 'Astro.props without a `Props` type: type `props<...>()`')
    }
    else if (name === 'generator') {
      at(inner, '\'kay\'')
    }
    else if (page && ['url', 'params', 'request', 'cookies', 'redirect'].includes(name)) {
      at(inner, `ctx.${name}`)
    }
    else {
      note(line, `Astro.${name} has no kay counterpart ${page ? 'in a page' : 'in a component, which has no request: pass what it needs as a prop'}`)
    }

    return false
  })

  return edits
}

function isMetaEnv(node: t.Node): boolean {
  return node.type === 'MemberExpression' && node.object.type === 'MetaProperty' && node.object.meta.name === 'import' && node.object.property.name === 'meta' && node.property.type === 'Identifier' && node.property.name === 'env'
}

// The font a Fontsource stylesheet import declares, or undefined for a file kay migrate does not know.
function fontOf(specifier: string, line: number): FontImport | undefined {
  const match = FONTSOURCE.exec(specifier)
  const fontsource = match?.[1]

  if (fontsource === undefined)
    return undefined

  const file = match?.[2]
  const variable = fontsource.startsWith('@fontsource-variable/')

  if (file === undefined || file === 'index')
    return variable ? { line, fontsource, weight: undefined, style: 'normal' } : { line, fontsource, weight: 400, style: 'normal' }

  const weight = FONT_WEIGHT.exec(file)

  if (weight && !variable)
    return { line, fontsource, weight: Number(weight[1]), style: weight[2] === 'italic' ? 'italic' : 'normal' }

  const spans = FONT_VARIABLE.exec(file)

  if (spans && variable)
    return { line, fontsource, weight: undefined, style: spans[1] === 'italic' ? 'italic' : 'normal' }

  return undefined
}

function isAstro(node: t.Node, name: string): boolean {
  return node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Astro' && node.property.type === 'Identifier' && node.property.name === name
}
