import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check } from '../src/check'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const COMPONENTS = {
  'src/card.kay': 'section.card\n  header(part="head") a\n  div(part="body")\n    slot\n',
  'src/plain.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv(class={className}) a\n',
  'src/pair.kay': 'header(part="top") a\nfooter(part="bottom") b\n',
  'src/panel.kay': '---\nimport Card from \'./card.kay\'\n---\nsection.panel\n  Card(part="card") body\n',
}
const IMPORTS = '---\nimport Card from \'../card.kay\'\nimport Pair from \'../pair.kay\'\nimport Panel from \'../panel.kay\'\nimport Plain from \'../plain.kay\'\nconst rest = { id: \'x\' }\n---\n'

async function problems(page: string): Promise<string[]> {
  const root = await scratchDir('parts-check-')

  try {
    await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...COMPONENTS, 'src/routes/index.kay': page }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await check(root)).map(diagnostic => diagnostic.message.slice(0, diagnostic.message.includes('\n') ? diagnostic.message.indexOf('\n') : undefined)).filter(message => !message.includes('is declared but'))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('kay check on a component with parts', () => {
  it('passes a string for the root, an object of parts, and a nested object for a part that is a component', async () => {
    expect(await problems(`${IMPORTS}Card(class="mt-4") a\nCard(class={{ root: 'mt-4', head: 'p-6' }}) b\nPair(class={{ top: 'a', bottom: 'b' }})\nPanel(class={{ card: { head: 'p-2' }, root: 'x' }})\nPanel(class={{ card: 'mt-2' }})\n`)).toEqual([])
  })

  it('reports a part the component does not have, at the call', async () => {
    expect(await problems(`${IMPORTS}Card(class={{ foot: 'p-6' }}) a\n`)).toEqual([expect.stringContaining('foot')])
    expect(await problems(`${IMPORTS}Panel(class={{ card: { foot: 'p-6' } }})\n`)).toEqual([expect.stringContaining('foot')])
  })

  it('reports a string class on a template with several top elements and no root', async () => {
    expect(await problems(`${IMPORTS}Pair(class="mt-4")\n`)).toEqual([expect.stringContaining('several top elements')])
  })

  it('reports a parts object beside a shorthand or a spread, which could be a condition object, and lets a condition object through', async () => {
    expect(await problems(`${IMPORTS}Card.mt-4(class={{ head: 'p-6' }}) a\n`)).toEqual([expect.stringContaining('cannot be merged')])
    expect(await problems(`${IMPORTS}Card({...rest} class={{ head: 'p-6' }}) a\n`)).toEqual([expect.stringContaining('cannot be merged')])
    expect(await problems(`${IMPORTS}Plain.mt-4(class={{ on: true }})\nPlain({...rest} class={{ on: true }})\n`)).toEqual([])
  })

  it('reads a condition object with a string-typed value beside a shorthand as a parts object, which the docs say', async () => {
    expect(await problems(`${IMPORTS}Plain.mt-4(class={{ 'p-4': rest.id }})\n`)).toEqual([expect.stringContaining('cannot be merged')])
  })
})
