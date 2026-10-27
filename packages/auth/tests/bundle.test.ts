import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { scratchDir } from 'kay/test'

// `kay build --compile` reaches passkeys through `import()`, which Bun's bundler wraps in lazy initialisers: they must load there as they do unbundled.
test('passkeys load in a bundle reaching them through import()', async () => {
  const dir = await scratchDir('bundle-')

  try {
    const entry = join(dir, 'entry.ts')

    await Bun.write(entry, `await import(${JSON.stringify(join(import.meta.dir, '../src/passkeys.ts'))})\nconsole.log('loaded')\n`)
    const build = await Bun.build({ entrypoints: [entry], outdir: dir, target: 'bun', format: 'esm' })

    expect(build.success).toBe(true)

    const run = Bun.spawn([process.execPath, join(dir, 'entry.js')], { stdout: 'pipe', stderr: 'pipe' })
    const [out, errors, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

    expect({ code, out, errors }).toEqual({ code: 0, out: 'loaded\n', errors: '' })
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
})
