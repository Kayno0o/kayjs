import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { textSizeColour } from '../src/check/text-size-colour'
import { scratchDir } from './scratch'

async function found(files: Record<string, string>, lints?: Record<string, 'allow'>) {
  const root = await scratchDir('text-size-colour-')

  try {
    await Promise.all(Object.entries({ 'tsconfig.json': '{}', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await textSizeColour(root, { lints })).map(item => [item.file.slice(root.length + 1), item.line, item.message.slice(0, item.message.indexOf(' '))])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('reports each use of a size whose name is also a theme colour', async () => {
  expect(await found({
    'src/app.css': '@import \'tailwindcss\';\n@theme { --color-base: #1e1e2e; }\nbutton { @apply hover:text-base; }\n',
    'src/routes/index.kay': 'p.text-base Hello\nspan(class="text-sm text-base/6") World\n',
  })).toEqual([['src/app.css', 3, '`text-base`'], ['src/routes/index.kay', 1, '`text-base`'], ['src/routes/index.kay', 2, '`text-base`']])
})

it('leaves a size alone when no colour of the theme has its name, and comments', async () => {
  expect(await found({ 'src/app.css': '@theme { --color-background: #000; }\n', 'src/routes/index.kay': 'p.text-base Hello\n' })).toEqual([])
  expect(await found({ 'src/app.css': '/* --color-base: #000 */\n:root { --color-lg: red; }\n', 'src/routes/index.kay': '// text-base\np.text-sm.text-background Hello\np.text-lg-x hi\n' })).toEqual([])
})

it('is silenced by allowing it', async () => {
  expect(await found({ 'src/app.css': '@theme { --color-base: #000; }\n', 'src/routes/index.kay': 'p.text-base Hello\n' }, { 'text-size-colour': 'allow' })).toEqual([])
})
