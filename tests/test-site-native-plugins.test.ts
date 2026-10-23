import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { fixtureCopy, scratchDir } from './scratch'

// Bun keeps the global of a file alive for as long as the process runs once the file loaded a native addon, and under `bun test --isolate` that is every module the file imported: a site whose config imports Tailwind's plugin costs the run its whole module graph per file.
it.skipIf(!existsSync('/proc/self/maps'))('a site that builds no client for a browser loads no native addon, though its config imports the Tailwind plugin', async () => {
  const root = resolve(await fixtureCopy('bare'))
  const script = join(await scratchDir('native-'), 'run.ts')

  // A stylesheet only Tailwind's plugin parses, which the check build must not hand to Bun's own parser.
  await Bun.write(join(root, 'src/app.css'), '@import "tailwindcss" source("..");\n')
  await Bun.write(join(root, 'src/routes/_layout.kay'), `---\nimport '../app.css'\n---\nslot\n`)
  await Bun.write(join(root, 'kay.config.ts'), `import tailwind from 'bun-plugin-tailwind'\nimport { defineConfig } from 'kay/server'\n\nexport default defineConfig({ plugins: [tailwind] })\n`)
  await Bun.write(script, `import { readFileSync } from 'node:fs'
import { testSite } from ${JSON.stringify(resolve('src/test'))}

const loaded = () => readFileSync('/proc/self/maps', 'utf8').includes('tailwindcss-oxide')
const site = await testSite({ root: ${JSON.stringify(root)} })
const response = await site.fetch('/')
const afterSite = loaded()

await site.close()
// What the check proves: the addon shows in the process's maps once the real plugin loads.
await import(Bun.resolveSync('bun-plugin-tailwind', ${JSON.stringify(root)}))
console.log(JSON.stringify({ status: response.status, afterSite, afterPlugin: loaded() }))
process.exit(0)
`)

  const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })
  expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ status: 200, afterSite: false, afterPlugin: true })
}, 60_000)
