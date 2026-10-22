import { dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'

// `bun test --changed` follows a test's imports, so a test that runs kay in a subprocess (`src/cli.ts build ...`) or loads a module by path at run time is not reached by a change under `src/`. This maps each such test to the files its subprocesses load: the entries it names by path, and for the CLI the commands it passes, followed through static and dynamic imports.
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts']
const transpiler = new Bun.Transpiler({ loader: 'ts' })
// An entry named as a path to a source file or folder: `'../src/cli.ts'`, `'src/dev/preload.ts'`, or relative to a `SRC` constant as in `join(SRC, 'check/index.ts')`; a module loaded through another form is not seen.
const ENTRY = /['"`]((?:\.\.\/)*src\/[\w/.-]+|(?<=\bSRC, ['"`])[\w/.-]+)['"`]/g
const SOURCE = /\.[jt]sx?$/
const AFTER_WORD = / .*/
const SHEBANG = /^#!.*/
const LEADING_PARENTS = /^(?:\.\.\/)*/
const COMMAND = /^\s+'([a-z-]+(?: [a-z]+)?)': async \(\) => \(await import\('\.\/commands\/([\w-]+)'\)\)/gm

async function resolveFile(base: string) {
  for (const extension of EXTENSIONS) {
    const path = base + extension

    if (SOURCE.test(path) && await Bun.file(path).exists())
      return path
  }
}

// Every source file reachable from `entries` through relative imports, dynamic ones included, memoised per file in `edges`.
async function closure(entries: string[], edges: Map<string, Promise<string[]>>) {
  const seen = new Set<string>()
  const queue = [...entries]

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    if (!edges.has(file)) {
      edges.set(file, (async () => {
        const text = await Bun.file(file).text()
        const found: string[] = []

        for (const { path } of transpiler.scanImports(text.replace(SHEBANG, ''))) {
          const target = path.startsWith('.') ? await resolveFile(resolve(dirname(file), path)) : undefined

          if (target !== undefined)
            found.push(target)
        }

        return found
      })())
    }

    queue.push(...await edges.get(file)!)
  }

  return seen
}

// The test files, among `tests`, whose subprocesses or by-path loads reach a file in `changed` (paths from `root`) that the test's own imports do not.
export async function subprocessTests(root: string, changed: string[]) {
  const sources = changed.filter(path => path.startsWith('src/') && SOURCE.test(path)).map(path => join(root, path))

  if (sources.length === 0)
    return []

  const edges = new Map<string, Promise<string[]>>()
  const cli = join(root, 'src/cli.ts')
  const commands = new Map<string, string>()

  for (const [, name, file] of (await Bun.file(cli).text()).matchAll(COMMAND))
    commands.set(name!, file!)

  const reached: string[] = []

  for await (const test of new Glob('tests/*.test.ts').scan(root)) {
    const testFile = join(root, test)
    const text = await Bun.file(testFile).text()
    const entries: string[] = []

    for (const [, literal] of text.matchAll(ENTRY)) {
      const path = literal!.replace(LEADING_PARENTS, '')
      const file = await resolveFile(join(root, path.startsWith('src/') ? path : `src/${path}`))

      if (file !== undefined)
        entries.push(file)
    }

    if (entries.includes(cli)) {
      for (const [name, file] of commands) {
        if (new RegExp(`[\\[,(] *['"\`]${name.replace(AFTER_WORD, '')}['"\`]`).test(text)) {
          const entry = await resolveFile(join(root, 'src/commands', file))

          if (entry !== undefined)
            entries.push(entry)
        }
      }
    }

    if (entries.length === 0)
      continue

    const own = await closure([testFile], edges)

    if (sources.some(source => own.has(source)))
      continue

    const spawned = await closure(entries, edges)

    if (sources.some(source => spawned.has(source)))
      reached.push(test)
  }

  return reached.sort()
}
