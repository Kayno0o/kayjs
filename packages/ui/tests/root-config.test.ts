import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'bun:test'
import { scratchDir } from '../../../tests/scratch'

const LIBRARY = join(import.meta.dir, '..')

// A kay.config.ts is loaded by plain Bun, which resolves no `~icons/*` module: the root must not reach the icon defaults when it loads.
it('loads ui() from the package root in a config run by plain Bun, with /extension as its alias', async () => {
  const dir = await scratchDir('root-config-')
  const link = join(dir, 'node_modules/@kayjs/ui')

  await mkdir(dirname(link), { recursive: true })
  await symlink(LIBRARY, link)
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'root-config', private: true, type: 'module' }))
  await writeFile(join(dir, 'kay.config.ts'), 'import { ui } from \'@kayjs/ui\'\nimport { ui as aliased } from \'@kayjs/ui/extension\'\n\nconsole.log(JSON.stringify({ name: ui().name, same: ui === aliased }))\n')

  const run = Bun.spawn([process.execPath, 'kay.config.ts'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  expect(err).not.toContain('~icons')
  expect(code).toBe(0)
  expect(JSON.parse(out)).toEqual({ name: '@kayjs/ui', same: true })
})
