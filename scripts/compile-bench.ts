// Times the compiler on every `.kay` file of the docs site and the libraries: server markup, server markup that hydrates, the browser's DOM and the type-check output.
// Its digest hashes every output, so a refactor of the emitters proves its output is byte-identical: `bun scripts/compile-bench.ts [runs] [--digest-only]`.
import { createHash } from 'node:crypto'
import { Glob } from 'bun'
import { compileKay } from '../src/compiler'

const targets = {
  html: { output: 'html' },
  hydratable: { output: 'html', hydratable: true },
  dom: { output: 'dom' },
  check: { check: true },
} as const

const NUMBER = /^\d+$/
const root = new URL('..', import.meta.url).pathname
const files: { path: string, source: string }[] = []

for (const pattern of ['docs/**/*.kay', 'packages/*/src/**/*.kay']) {
  for await (const path of new Glob(pattern).scan({ cwd: root, absolute: true })) {
    if (!path.includes('node_modules'))
      files.push({ path, source: await Bun.file(path).text() })
  }
}

files.sort((a, b) => a.path.localeCompare(b.path))

const runs = Number(process.argv.find(argument => NUMBER.test(argument)) ?? 5)
const digest = createHash('sha256')
const times: Record<string, number[]> = {}

function compileAll(name: keyof typeof targets, hash: boolean): number {
  const started = performance.now()

  for (const file of files) {
    let result: ReturnType<typeof compileKay> | undefined

    try {
      result = compileKay(file.source, file.path, { root, ...targets[name] })
    }
    catch (error) {
      if (hash)
        digest.update(`${name} ${file.path} threw ${error instanceof Error ? error.message : String(error)}`)

      continue
    }

    if (hash)
      digest.update(`${name} ${file.path}\n${result.tsx}\n${JSON.stringify(result.diagnostics)}\n`)
  }

  return performance.now() - started
}

for (const name of Object.keys(targets) as (keyof typeof targets)[])
  compileAll(name, true)

console.log(`${files.length} files, digest ${digest.digest('hex').slice(0, 16)}`)

if (process.argv.includes('--digest-only'))
  process.exit(0)

for (const name of Object.keys(targets) as (keyof typeof targets)[]) {
  times[name] = []

  for (let run = 0; run < runs; run++)
    times[name].push(compileAll(name, false))
}

for (const [name, list] of Object.entries(times)) {
  const sorted = [...list].sort((a, b) => a - b)

  console.log(`${name.padEnd(10)} median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)} ms, best ${sorted[0]!.toFixed(0)} ms (${runs} runs)`)
}
