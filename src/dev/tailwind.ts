import { dirname, join, resolve } from 'node:path'
import { CSS_FILE } from '../build/files'
import { sourceWords } from '../build/libraries'
import { referencesOf, withReferences } from '../build/references'

// Whether the words an edit brought into a file, given its text, may be Tailwind classes, which only building the stylesheets again puts in.
export type ClassWords = (words: string[], text: string) => boolean

interface Compiler {
  build: (candidates: string[]) => string
}

export const TAILWIND_IMPORT = /@import\s+(?:url\(\s*)?['"]tailwindcss['"]/
// A word cut out of an arbitrary value, which only the stylesheet build reads whole.
const ARBITRARY = /[[\]\\]/
// What separates the strings Tailwind reads a class from, coarser than the words: `py-1.5` or `bg-(--brand)` stays whole.
const NOT_IN_CANDIDATE = /[\s'"`]+/

// Tailwind's compiler for each stylesheet importing it among `inputs`, from the app's own `tailwindcss`, asked which words make classes; undefined when none does or it cannot load, which leaves any new word to build the stylesheets again.
// A word only counts once Tailwind compiles it into a rule, so building again after a class keeps the next answer true: the stylesheet build compiles a fresh one.
export async function tailwindClasses(root: string, inputs: Iterable<string>): Promise<ClassWords | undefined> {
  try {
    const sheets = await Promise.all([...inputs].filter(file => CSS_FILE.test(file)).map(async file => ({ file, text: await Bun.file(file).text() })))
    const compilers = await Promise.all(sheets.filter(({ text }) => TAILWIND_IMPORT.test(text)).map(async ({ file, text }) => compiled(file, withReferences(text, file, root, referencesOf(root)))))

    if (compilers.length === 0)
      return undefined

    return (words, text) => {
      if (words.some(word => ARBITRARY.test(word)))
        return true

      const fresh = new Set(words)
      const candidates = new Set(words)

      for (const part of text.split(NOT_IN_CANDIDATE)) {
        if (!sourceWords(part).some(word => fresh.has(word)))
          continue

        // A dotted shorthand such as `p.py-1.5` also as each value its dots may split.
        const pieces = part.split('.')

        candidates.add(part)
        for (let i = 1; i < pieces.length; i++)
          candidates.add(`${pieces[i - 1]}.${pieces[i]}`)
      }

      try {
        return compilers.some(({ compiler, empty }) => compiler.build([...candidates]) !== empty)
      }
      catch {
        return true
      }
    }
  }
  catch {
    return undefined
  }
}

async function compiled(file: string, css: string): Promise<{ compiler: Compiler, empty: string }> {
  const base = dirname(file)
  const { compile } = await import(Bun.resolveSync('tailwindcss', base)) as { compile: (css: string, options: object) => Promise<Compiler> }
  const compiler = await compile(css, {
    base,
    loadStylesheet: async (id: string, from: string) => {
      const path = await stylesheetPath(id, from)

      return { path, base: dirname(path), content: await Bun.file(path).text() }
    },
    // A plugin or a config module may change between edits, which an import here would not see.
    loadModule: () => {
      throw new Error('kay: a Tailwind module is left to the stylesheet build')
    },
  })

  return { compiler, empty: compiler.build([]) }
}

// A stylesheet `@import` names: a relative path, or a package by its `style` entry.
export async function stylesheetPath(id: string, from: string): Promise<string> {
  if (id.startsWith('.'))
    return resolve(from, id)

  const path = Bun.resolveSync(id, from)

  if (CSS_FILE.test(path))
    return path

  const manifest = Bun.resolveSync(`${id}/package.json`, from)

  return join(dirname(manifest), (await Bun.file(manifest).json() as { style: string }).style)
}
