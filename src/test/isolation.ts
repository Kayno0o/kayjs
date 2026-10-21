import { readFileSync } from 'node:fs'

const ISOLATING_FLAGS = new Set(['--isolate', '--test-worker'])

// Whether this test run gives each file modules of its own, read from the run's command line (Bun keeps its flags out of `process.argv`), which only Linux has: undefined where it cannot be read.
// `--parallel` isolates unless `--no-isolate` takes it back.
export function isolatedRun(): boolean | undefined {
  try {
    const flags = readFileSync('/proc/self/cmdline', 'utf8').split('\0')

    if (flags.includes('--no-isolate'))
      return false

    return flags.some(flag => ISOLATING_FLAGS.has(flag) || flag === '--parallel' || flag.startsWith('--parallel='))
  }
  catch {
    return undefined
  }
}
