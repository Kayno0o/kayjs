import { join } from 'node:path'

const SOURCE = join(import.meta.dir, 'src')
const KEBAB = /(?:^|[-/])(\w)/g

// Writes src/demos.ts, the registry `<Demo name="button/variants" />` reads: every src/ui-examples/<component>/<name>.kay, its component and its highlighted source.
const files = [...new Bun.Glob('ui-examples/*/*.kay').scanSync(SOURCE)].sort()
const demos = files.map(file => ({ file, name: file.slice('ui-examples/'.length, -'.kay'.length) }))
const identifier = (name: string) => name.replace(KEBAB, (_match, letter: string) => letter.toUpperCase())

const module = `// Written by docs/demos.ts from src/ui-examples: run \`bun docs/demos.ts\` after adding or removing an example.
import type { SafeHtml } from 'kay'
import { join } from 'node:path'
import { highlightCode } from 'kay/content'
import { highlight } from './highlight'
${demos.map(({ file, name }) => `import ${identifier(name)} from './${file}'`).join('\n')}

const components = {
${demos.map(({ name }) => `  '${name}': ${identifier(name)},`).join('\n')}
}

export type DemoName = keyof typeof components

const source = async (name: string) => highlightCode((await Bun.file(join(import.meta.dir, 'ui-examples', \`\${name}.kay\`)).text()).trimEnd(), 'kay', { highlight })

export const demos = Object.fromEntries(await Promise.all(Object.entries(components).map(async ([name, component]) => [name, { component, html: await source(name) }]))) as Record<DemoName, { component: typeof components[DemoName], html: SafeHtml }>
`

await Bun.write(join(SOURCE, 'demos.ts'), module)
