// `bun run lint`: kay's own files, linted in one process per group of type-aware files (`typeAwareSlices`) and one for everything else, each under a heap of its own, so a lint peaks under 2 GB where one process over every file reaches 4 GB.
import { join } from 'node:path'
import { typeAwareSlices } from '../eslint.slices'
import { dropStaleLintCache } from './lint-cache'

const HEAP_MB = 2048
const keslint = join(import.meta.dir, '../node_modules/.bin/keslint')
const rest = ['.', '--ignore-pattern', 'packages/**', ...typeAwareSlices.flat().flatMap(glob => ['--ignore-pattern', glob])]
// Each process caches in a file of its own: ESLint drops from a cache the files its run did not lint.
const flags = process.argv.slice(2)
// Files named on the command line are one pass, not one in each group.
const named = flags.some(flag => !flag.startsWith('-'))
const passes = named ? [[]] : [...typeAwareSlices, null]
let status = 0

// A dependency install changes the types a file's lint reads, so results cached before it are dropped.
await dropStaleLintCache(join(import.meta.dir, '..'))

for (const [index, slice] of passes.entries()) {
  const child = Bun.spawnSync([keslint, '--cache', '--cache-location', `.eslintcache-${index}`, ...flags, ...slice ?? rest], {
    env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    stdio: ['inherit', 'inherit', 'inherit'],
  })

  // A pass the system killed, out of memory most often, has no exit code and printed nothing to tell it from a lint error.
  if (child.signalCode !== undefined)
    console.error(`lint: pass ${index + 1} of ${passes.length} (${slice?.join(' ') ?? 'the other files'}) was killed by ${child.signalCode}`)

  status = Math.max(status, child.exitCode ?? 1)
}

// The size baseline (eslint-ratchet.json) follows the files: the lint above stops a file from growing, this stops a baseline that kept the old size of one that shrank.
if (!named && !flags.includes('--fix'))
  status = Math.max(status, Bun.spawnSync([process.execPath, join(import.meta.dir, 'ratchet.ts')], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode ?? 1)

process.exit(status)
