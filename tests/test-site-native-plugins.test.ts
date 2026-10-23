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
await import(Bun.resolveSync('bun-plugin-tailwind', ${JSON.stringify(root)}) + '?real')
console.log(JSON.stringify({ status: response.status, afterSite, afterPlugin: loaded() }))
process.exit(0)
`)

  const child = Bun.spawn([process.execPath, script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })
  expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ status: 200, afterSite: false, afterPlugin: true })
}, 60_000)

async function run(script: string, cwd: string): Promise<unknown> {
  const file = join(await scratchDir('native-run-'), 'run.ts')

  await Bun.write(file, script)

  const child = Bun.spawn([process.execPath, file], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect({ code, errors }).toEqual({ code: 0, errors: '' })

  return JSON.parse(out.trim().split('\n').at(-1)!)
}

it('the shim carries the real plugin\'s name and exports, so a test build and a kay build share a slot', async () => {
  const root = resolve(await fixtureCopy('bare'))
  const lazy = JSON.stringify(resolve('src/test/lazy-plugins'))

  await Bun.write(join(root, 'probe.ts'), `export * as shim from 'bun-plugin-tailwind'\n`)

  const result = await run(`import { NATIVE_PLUGINS, lazyNativePlugins } from ${lazy}

lazyNativePlugins()

const { shim } = await import(${JSON.stringify(join(root, 'probe.ts'))})
const seen = { name: shim.default.name, kayNative: shim.default.kayNative, exports: Object.keys(shim).sort() }
const real = await import(Bun.resolveSync('bun-plugin-tailwind', ${JSON.stringify(root)}) + '?real')

console.log(JSON.stringify({ table: NATIVE_PLUGINS['bun-plugin-tailwind'], seen, real: { name: real.default.name, exports: Object.keys(real).sort() } }))
process.exit(0)
`, root) as { table: string, seen: { name: string, kayNative: boolean, exports: string[] }, real: { name: string, exports: string[] } }

  expect(result.seen.name).toBe(result.real.name)
  expect(result.table).toBe(result.real.name)
  expect(result.seen.exports).toEqual(result.real.exports)
  expect(result.seen.kayNative).toBe(true)
}, 60_000)

it('the shim runs the plugin of the project importing it, not of the first one registered', async () => {
  const first = await scratchDir('native-first-')
  const second = await scratchDir('native-second-')

  for (const [dir, tag] of [[first, 'first'], [second, 'second']] as const) {
    await Bun.write(join(dir, 'node_modules/bun-plugin-tailwind/package.json'), JSON.stringify({ name: 'bun-plugin-tailwind', type: 'module', exports: './index.mjs' }))
    await Bun.write(join(dir, 'node_modules/bun-plugin-tailwind/index.mjs'), `export default { name: '@tailwindcss/bun', setup() { globalThis.ran = ${JSON.stringify(tag)} } }\nexport const extra = ${JSON.stringify(tag)}\n`)
    await Bun.write(join(dir, 'config.ts'), `export { default, extra } from 'bun-plugin-tailwind'\n`)
  }

  const result = await run(`import { lazyNativePlugins } from ${JSON.stringify(resolve('src/test/lazy-plugins'))}

lazyNativePlugins()

const ran: unknown[] = []

for (const dir of [${JSON.stringify(first)}, ${JSON.stringify(second)}]) {
  const config = await import(dir + '/config.ts')

  await config.default.setup({})
  ran.push([(globalThis as { ran?: string }).ran, config.extra])
}

console.log(JSON.stringify(ran))
process.exit(0)
`, first)

  expect(result).toEqual([['first', 'first'], ['second', 'second']])
}, 60_000)

it('a check build\'s empty stylesheets keep the class names of a stylesheet module', async () => {
  const dir = await scratchDir('native-module-')

  await Bun.write(join(dir, 's.module.css'), '/* .gone */ .card { background: url(a.png) } .card-title, .x_y > .z:hover { margin: 0.5em; content: ".quoted" }\n')
  await Bun.write(join(dir, 'plain.css'), '@import "tailwindcss" source("..");\n')
  await Bun.write(join(dir, 'entry.ts'), `import styles, { card, x_y } from './s.module.css'\nimport './plain.css'\nconsole.log(styles['card-title'], styles.z, card, x_y)\n`)

  const result = await run(`import { checkOnly } from ${JSON.stringify(resolve('src/test/lazy-plugins'))}

const options = checkOnly({ plugins: [{ name: '@tailwindcss/bun', kayNative: true, setup() {} }] } as never)
const build = await Bun.build({ entrypoints: [${JSON.stringify(join(dir, 'entry.ts'))}], target: 'browser', plugins: options.plugins, throw: false })

console.log(JSON.stringify({ success: build.success, logs: build.logs.map(String) }))
`, dir)

  expect(result).toEqual({ success: true, logs: [] })
}, 60_000)
