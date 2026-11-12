import { dirname } from 'node:path'
import { elementsIn } from '../compiler/ast'
import { parseExpanded } from '../compiler/markdown-block'

// A component names the features an app may leave out with `uses('selectable')`: a call that is true while the prop is there to be written, and that a browser build replaces with `true` or `false` once it has read the props the importing file writes at its call sites. See `specializedSource`.
const USES_CALL = /\buses\(\s*'(\w+)'\s*\)/g
const KAY_IMPORT = /^import\s+(\w+)\s+from\s+(["'])([^"'\n]+\.kay)\2/gm
// A line opening a fence, whose last one precedes the template.
const FENCE = /^---(?:\s|$)/
// A template `if` whose condition calls `uses()`.
const USES_IF = /^([ \t]*)if (.*\buses\(.*)$/

// The suffix an import of a variant carries: the features, joined by dots, the call sites of the importing file use.
export const USES_QUERY = /\.kay\?uses=([\w.]*)$/

const featuresOf = new Map<string, Promise<string[]>>()

export function usesNames(source: string): string[] {
  return [...new Set([...source.matchAll(USES_CALL)].map(match => match[1]!))]
}

async function readNames(path: string): Promise<string[]> {
  try {
    return usesNames(await Bun.file(path).text())
  }
  catch {
    return []
  }
}

// The features a component file names, read once: none when the file has no `uses()` call or cannot be read.
async function declaredFeatures(path: string): Promise<string[]> {
  let found = featuresOf.get(path)

  if (found === undefined) {
    found = readNames(path)
    featuresOf.set(path, found)
  }

  return found
}

// Whether a condition made of `true`, `false` and anything else, joined by `&&` and `||`, is `false` whatever the rest holds.
function alwaysFalse(condition: string): boolean {
  const text = condition.trim()
  const terms = splitTop(text, '||')

  if (terms === undefined)
    return false

  return terms.every((term) => {
    const factors = splitTop(term, '&&')

    if (factors === undefined)
      return false

    return factors.some((factor) => {
      const inner = factor.trim()

      return inner === 'false' || (inner.startsWith('(') && inner.endsWith(')') && splitTop(inner, '&&')?.length === 1 && alwaysFalse(inner.slice(1, -1)))
    })
  })
}

// `text` cut at the `operator`s outside brackets and strings; undefined for a text holding a `?`, whose precedence this does not read.
function splitTop(text: string, operator: '&&' | '||'): string[] | undefined {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let from = 0

  for (let at = 0; at < text.length; at++) {
    const char = text[at]!

    if (quote !== '') {
      if (char === '\\')
        at++
      else if (char === quote)
        quote = ''
    }
    else if (char === '\'' || char === '"' || char === '`') {
      quote = char
    }
    else if (char === '(' || char === '[' || char === '{') {
      depth++
    }
    else if (char === ')' || char === ']' || char === '}') {
      depth--
    }
    else if (char === '?' && depth === 0) {
      return undefined
    }
    else if (depth === 0 && text.startsWith(operator, at)) {
      parts.push(text.slice(from, at))
      at += operator.length - 1
      from = at + 1
    }
  }

  parts.push(text.slice(from))

  return parts
}

// The source with each `uses('x')` as `true` when `x` is among `present`, `false` otherwise, and a template `if` that cannot hold with them reduced to `if false` with its lines blanked: the block keeps its markers for the server markup the island hydrates, and the lines keep their numbers for the source map. A block of that kind has no `else` after it.
export function specializedSource(source: string, present: ReadonlySet<string>): string {
  const lines = source.split('\n')
  const replaced = (text: string) => text.replace(USES_CALL, (_call, name: string) => present.has(name) ? 'true' : 'false')

  // The template starts after the last fence line.
  const template = lines.findLastIndex(line => FENCE.test(line)) + 1

  for (let at = template; at < lines.length; at++) {
    const hit = USES_IF.exec(lines[at]!)

    if (hit === null)
      continue

    const condition = replaced(hit[2]!)

    if (!alwaysFalse(condition)) {
      lines[at] = `${hit[1]}if ${condition}`

      continue
    }

    const indent = hit[1]!.length

    lines[at] = `${hit[1]}if false`

    for (let next = at + 1; next < lines.length; next++) {
      const line = lines[next]!

      if (line.trim() !== '' && line.length - line.trimStart().length <= indent)
        break

      lines[next] = ''
      at = next
    }
  }

  return replaced(lines.join('\n'))
}

// The props the call sites of each `.kay` component a file imports write, by the name the file gives it: a component read anywhere but as a tag, or called with a spread, is left out, as every prop of it may be written.
export function propsWritten(source: string, locals: readonly string[]): Map<string, Set<string>> {
  const { file } = parseExpanded(source)
  const written = new Map<string, Set<string>>()
  const calls = new Map<string, number>()
  const open = new Set(locals)

  for (const element of elementsIn(file.template)) {
    if (!element.component || !open.has(element.name))
      continue

    calls.set(element.name, (calls.get(element.name) ?? 0) + 1)

    const props = written.get(element.name) ?? new Set<string>()

    written.set(element.name, props)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread')
        open.delete(element.name)
      else
        props.add(source.slice(attribute.name.start, attribute.name.end))
    }

    for (const child of element.children) {
      if (child.kind === 'slot')
        props.add(source.slice(child.name.start, child.name.end))
      else
        props.add('children')
    }
  }

  for (const local of locals) {
    // The import names it once, each call once more.
    if ((source.match(new RegExp(`\\b${local}\\b`, 'g'))?.length ?? 0) !== 1 + (calls.get(local) ?? 0))
      open.delete(local)
  }

  return new Map([...written].filter(([local]) => open.has(local)))
}

// The imports of the compiled `code` of `file` that name a component with features, pointed at the variant its call sites use: `import Table from './table.kay'` as `./table.kay?uses=pageSize`.
export async function variantImports(code: string, file: string, source: string): Promise<string> {
  const candidates = new Map<string, { specifier: string, features: string[] }>()

  for (const [, local, , specifier] of code.matchAll(KAY_IMPORT)) {
    let path: string

    try {
      path = Bun.resolveSync(specifier!, dirname(file))
    }
    catch {
      continue
    }

    const features = await declaredFeatures(path)

    if (features.length > 0)
      candidates.set(local!, { specifier: specifier!, features })
  }

  if (candidates.size === 0)
    return code

  const written = propsWritten(source, [...candidates.keys()])
  let result = code

  for (const [local, { specifier, features }] of candidates) {
    const props = written.get(local)

    if (props === undefined)
      continue

    const used = features.filter(feature => props.has(feature)).sort()

    result = result.replace(new RegExp(`^(import\\s+${local}\\s+from\\s+)(["'])${RegExp.escape(specifier)}\\2`, 'm'), (_import, head: string, quote: string) => `${head}${quote}${specifier}?uses=${used.join('.')}${quote}`)
  }

  return result
}
