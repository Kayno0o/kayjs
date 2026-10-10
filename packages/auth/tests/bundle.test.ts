import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

// Bun's bundler wraps what an `import()` reaches in lazy initialisers, which run a module's CommonJS imports after its ES ones: the polyfill tsyringe needs must still load first.
test('passkeys load in a bundle reaching them through import()', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayjs-auth-bundle-'))

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
