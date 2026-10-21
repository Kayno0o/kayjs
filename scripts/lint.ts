// `bun run lint`: kay's own files, linted in one process per group of type-aware files (`typeAwareSlices`) and one for everything else, each under a heap of its own, so a lint peaks under 2 GB where one process over every file reaches 4 GB.
import { join } from 'node:path'
import { typeAwareSlices } from '../eslint.slices'

const HEAP_MB = 1536
const keslint = join(import.meta.dir, '../node_modules/.bin/keslint')
const rest = ['.', '--ignore-pattern', 'packages/**', ...typeAwareSlices.flat().flatMap(glob => ['--ignore-pattern', glob])]
// Each process caches in a file of its own: ESLint drops from a cache the files its run did not lint.
const passes = [...typeAwareSlices, null]
const flags = process.argv.slice(2)
let status = 0

for (const [index, slice] of passes.entries()) {
  const child = Bun.spawnSync([keslint, '--cache', '--cache-location', `.eslintcache-${index}`, ...flags, ...slice ?? rest], {
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  status = Math.max(status, child.exitCode ?? 1)
}

process.exit(status)
