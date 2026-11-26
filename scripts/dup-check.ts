// Enforces the copy-paste duplication threshold across `packages/*/src/**/*.{ts,tsx}` using `jscpd`.

import { resolve } from 'node:path'
import { fail, parse, runMain } from '@kaynooo/cli-kit'

const ROOT = resolve(import.meta.dir, '..')
const MIN_LINES = '15'
const MIN_TOKENS = '70'
const DEFAULT_THRESHOLD = '0.5'
const USAGE = 'bun run check:dup [options]: runs jscpd across packages/*/src/**/*.{ts,tsx} with --min-lines 15 --min-tokens 70 --threshold 0.5'

if (import.meta.main) {
  process.exitCode = await runMain({
    name: 'dup-check',
    usage: false,
    run: async (args) => {
      const { values } = parse(args, USAGE, {
        threshold: { type: 'string', description: `max duplicated percentage allowed (default: ${DEFAULT_THRESHOLD})` },
        strict: { type: 'boolean', description: 'fail if jscpd is not installed on PATH instead of skipping' },
      }, { exits: [[0, 'duplication is within threshold (or jscpd skipped)'], [1, 'duplication exceeded threshold'], [2, 'a usage error']] })

      const bin = Bun.which('jscpd')
      if (bin === null) {
        if (values.strict === true)
          return fail('jscpd is not installed on PATH', 1, 'install it with `bun add -g jscpd`')
        console.log('↷ dup-check skipped (jscpd not installed on PATH)')
        return 0
      }

      const threshold = values.threshold ?? DEFAULT_THRESHOLD
      const proc = Bun.spawn(
        [bin, 'packages', '--pattern', '**/src/**/*.{ts,tsx}', '--min-lines', MIN_LINES, '--min-tokens', MIN_TOKENS, '--threshold', threshold, '--silent'],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      if (code !== 0) {
        // Re-run without --silent to print exact clone locations.
        const detail = Bun.spawn(
          [bin, 'packages', '--pattern', '**/src/**/*.{ts,tsx}', '--min-lines', MIN_LINES, '--min-tokens', MIN_TOKENS, '--threshold', threshold],
          { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
        )
        await detail.exited
        if (stderr.trim().length > 0)
          console.error(stderr.trim())
        return fail(`copy-paste duplication exceeded ${threshold}% threshold`, 1, 'extract a shared helper for the duplicated blocks above')
      }

      const summaryLine = stdout.split('\n').find(l => l.includes('Found ') && l.includes('clone'))?.trim()
      console.log(`✓ duplication ok (<= ${threshold}%${summaryLine !== undefined ? `, ${summaryLine.toLowerCase()}` : ''})`)
      return 0
    },
  })
}
