import { join, resolve } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { fixtureCopy, scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')

// A production build or start never type-checks, so an install without the native compiler's platform package (an unsupported platform, optional dependencies left out) must still build.
it('builds with the typescript packages missing, and only the type-check asks for them', async () => {
  const dir = await scratchDir('native-typescript')
  const preload = join(dir, 'missing.ts')

  await Bun.write(preload, `const resolveSync = Bun.resolveSync\nBun.resolveSync = (specifier: string, parent: string) => {\n  if (specifier.startsWith('typescript7') || specifier.startsWith('@typescript/typescript-'))\n    throw new Error(\`Cannot find module \${specifier}\`)\n\n  return resolveSync(specifier, parent)\n}\n`)

  const root = resolve(await fixtureCopy('islands'))
  const build = Bun.spawn([process.execPath, '--preload', preload, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

  expect(await build.exited, stdout + stderr).toBe(0)

  const tsgo = Bun.spawn([process.execPath, '--preload', preload, join(import.meta.dir, '../src/tsgo.ts'), '--version'], { stdout: 'pipe', stderr: 'pipe' })

  expect(await tsgo.exited).not.toBe(0)
  expect(await new Response(tsgo.stderr).text()).toContain('Cannot find module typescript7/package.json')
}, 60_000)
