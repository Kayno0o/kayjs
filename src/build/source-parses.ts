import type { Span } from '../compiler/ast'
import type { Expression, Lang, Program } from '../compiler/estree'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ParseError, parseExpression, parseProgram } from '../compiler/estree'
import { parseExpanded } from '../compiler/markdown-block'
import { readSource } from './files'

type SourceRead = ReturnType<typeof readSource>
type Parsed = Program | Expression | ReturnType<typeof parseExpanded>

// A parse made, or what it threw, with the text it was made of: a `.kay` file's expanded source holds its fences where the file does.
interface Made {
  text: string
  parsed?: Parsed
  error?: unknown
}

const TS_SCRIPT = /\.[cm]?ts$/
const TSX_SCRIPT = /\.tsx$/

// A `.kay` file's fences.
export const FENCE_LANG: Lang = 'ts'
const building = new AsyncLocalStorage<Map<SourceRead, Map<string, Made>>>()

// The language a script file is parsed as, TypeScript for one with no file.
export function scriptLang(file: string | undefined): Lang {
  if (file === undefined || TS_SCRIPT.test(file))
    return FENCE_LANG

  return TSX_SCRIPT.test(file) ? 'tsx' : 'jsx'
}

// The file's read while it holds `text`.
export function readHolding(file: string | undefined, text: string): SourceRead | undefined {
  if (file === undefined)
    return undefined

  try {
    const read = readSource(file)

    return read.text === text ? read : undefined
  }
  catch {
    return undefined
  }
}

// Runs a build, in which the class index keeps the parses it makes for the kept-page scan to take up; whatever is left goes when it ends.
// Nowhere else is a parse kept: a tree costs about 37 times its text, and a dev server runs no kept-page scan.
export async function inParseScope<T>(run: () => Promise<T>): Promise<T> {
  return building.getStore() ? run() : building.run(new Map(), run)
}

// Drops what the kept-page scan left of the build's parses, once it ran, rather than hold them to the end of the build.
export function dropKeptParses(): void {
  building.getStore()?.clear()
}

// The parses of one source, shared by the class index and the kept-page scan, which read the same spans with the same options.
// The class index, which `stores`, keeps what it parses with the file's read in a build; the kept-page scan, which runs after it and reads each file once, takes a parse kept and keeps none.
export class SourceParses {
  private readonly kept: Map<string, Made> | undefined

  constructor(read: SourceRead | undefined, private readonly stores: boolean) {
    const scope = building.getStore()
    let kept = read === undefined ? undefined : scope?.get(read)

    if (read !== undefined && scope !== undefined && kept === undefined && stores)
      scope.set(read, kept = new Map<string, Made>())

    this.kept = kept
  }

  // A script or a fence, from `span` of `source`, its offsets the source's; throws what the parser throws.
  program(source: string, span: Span, lang: Lang): Program {
    return this.made(`program ${lang} ${span.start}`, source.slice(span.start, span.end), (text) => {
      const { program, errors } = parseProgram(text, { lang, offset: span.start, returnOutside: true, recover: true })

      // After an error it cannot recover from the parser leaves an empty program, which is no parse.
      if (errors.length > 0 && program.body.length === 0 && text.trim() !== '')
        throw new ParseError(errors[0]!.message, errors[0]!.pos)

      return program
    })
  }

  // An expression of a `.kay` template.
  expression(source: string, span: Span): Expression {
    return this.made(`expression ${span.start}`, source.slice(span.start, span.end), text => parseExpression(text, { offset: span.start }))
  }

  // The `.kay` file of the read, its markdown blocks lowered to the template they stand for.
  kay(source: string): ReturnType<typeof parseExpanded> {
    return this.made('kay', source, parseExpanded)
  }

  private made<T extends Parsed>(key: string, text: string, make: (text: string) => T): T {
    if (this.kept === undefined)
      return make(text)

    const known = this.stores ? undefined : this.taken(this.kept, key, text)

    if (known !== undefined) {
      if ('error' in known)
        throw known.error

      return known.parsed as T
    }

    const entry: Made = { text }

    if (this.stores)
      this.kept.set(key, entry)

    try {
      return entry.parsed = make(text)
    }
    catch (error) {
      entry.error = error

      throw error
    }
  }

  // The parse kept of `text`, which nothing reads again once taken.
  private taken(kept: Map<string, Made>, key: string, text: string): Made | undefined {
    const known = kept.get(key)

    if (known?.text !== text)
      return undefined

    kept.delete(key)

    return known
  }
}
