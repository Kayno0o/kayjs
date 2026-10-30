import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check } from '../src/check'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const compilerOptions = { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }
const tsconfig = JSON.stringify({ compilerOptions, include: ['src', '.kay/types'] })
const exact = JSON.stringify({ compilerOptions: { ...compilerOptions, exactOptionalPropertyTypes: true }, include: ['src', '.kay/types'] })
const COMPONENTS = {
  'src/card.kay': 'section.card\n  header(part="head") a\n  div(part="body")\n    slot\n',
  'src/plain.kay': '---\nconst { class: className } = props<{ class?: string }>()\n---\ndiv(class={className}) a\n',
  'src/strict.kay': '---\nconst { class: className } = props<{ class: string }>()\n---\ndiv(class={className}) a\n',
  'src/bare.kay': 'div a\n',
  'src/pair.kay': 'header(part="top") a\nfooter(part="bottom") b\n',
  'src/busy.kay': 'button(part="root")\n  span(part="spinner") a\n',
  'src/hands.kay': '---\nimport Busy from \'./busy.kay\'\n---\nBusy(part="root spinner")\n',
  'src/panel.kay': '---\nimport Card from \'./card.kay\'\n---\nsection.panel\n  Card(part="card") body\n',
}
const IMPORTS = '---\nimport Card from \'../card.kay\'\nimport Pair from \'../pair.kay\'\nimport Panel from \'../panel.kay\'\nimport Plain from \'../plain.kay\'\nconst rest = { id: \'x\' }\n---\n'

async function problems(page: string, route = 'src/routes/index.kay', config = tsconfig): Promise<string[]> {
  const root = await scratchDir('parts-check-')

  try {
    await Promise.all(Object.entries({ 'tsconfig.json': config, ...COMPONENTS, [route]: page }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await check(root)).map(diagnostic => diagnostic.message.slice(0, diagnostic.message.includes('\n') ? diagnostic.message.indexOf('\n') : undefined)).filter(message => !message.includes('is declared but'))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const HANDS = '---\nimport Busy from \'./busy.kay\'\nimport Plain from \'./plain.kay\'\n---\n'
const CALLER = 'src/caller.kay'

describe('kay check on a part handed to a called component', () => {
  it('reports a handed part the called component does not name, at the call', async () => {
    expect(await problems(`${HANDS}Busy(part="root spiner")\n`, CALLER)).toEqual([expect.stringContaining('spiner')])
    expect(await problems(`${HANDS}Plain(part="root head")\n`, CALLER)).toEqual([expect.stringContaining('head')])
  })

  it('types the handed part as the called component types it', async () => {
    expect(await problems(`${HANDS}Busy(part="root spinner")\n`, CALLER)).toEqual([])
    expect(await problems('---\nimport Hands from \'../hands.kay\'\n---\nHands(class={{ root: \'a\', spinner: \'b\' }})\n')).toEqual([])
    expect(await problems('---\nimport Hands from \'../hands.kay\'\n---\nHands(class={{ spinner: 5 }})\n')).toEqual([expect.stringContaining('not assignable')])
  })
})

describe('kay check on a component with parts', () => {
  it('passes a string for the root, an object of parts, and a nested object for a part that is a component', async () => {
    expect(await problems(`${IMPORTS}Card(class="mt-4") a\nCard(class={{ root: 'mt-4', head: 'p-6' }}) b\nPair(class={{ top: 'a', bottom: 'b' }})\nPanel(class={{ card: { head: 'p-2' }, root: 'x' }})\nPanel(class={{ card: 'mt-2' }})\n`)).toEqual([])
  })

  it('takes a part class that may be undefined under exactOptionalPropertyTypes', async () => {
    expect(await problems(`${IMPORTS}Card(class={{ head: rest.id === 'x' ? 'p-6' : undefined }}) a\n`, undefined, exact)).toEqual([])
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

  describe('a merged class on a component typing its class prop, under exactOptionalPropertyTypes', () => {
    const withExtra = async (page: string, config: string) => problems(page, 'src/routes/index.kay', config)

    it('passes a shorthand beside a condition object, an attribute string or a spread', async () => {
      for (const config of [tsconfig, exact]) {
        expect(await withExtra(`${IMPORTS}Plain.mt-4(class={{ on: true }})\nPlain.mt-4(class="p-2")\nPlain.mt-4(class={{ on: rest.id === 'x' }})\nPlain.mt-4({...rest} class={{ on: true }})\nPlain.mt-4({...rest})\n`, config)).toEqual([])
      }
    })

    it('passes a spread beside a condition object', async () => {
      for (const config of [tsconfig, exact]) {
        expect(await withExtra(`${IMPORTS}Plain({...rest} class={{ on: true }})\nPlain({...rest} class="a")\n`, config)).toEqual([])
      }
    })

    it('passes a class prop that is required when the class merges', async () => {
      const head = '---\nimport Strict from \'../strict.kay\'\nconst rest = { id: \'x\' }\n---\n'

      expect(await withExtra(`${head}Strict.mt-4(class={{ on: true }})\n`, exact)).toEqual([])
      expect(await withExtra(`${head}Strict.mt-4(class={{ on: true }})\n`, tsconfig)).toEqual([])
    })

    it('refuses a required class prop when the merge can be empty', async () => {
      const head = '---\nimport Strict from \'../strict.kay\'\nconst rest = { id: \'x\' }\n---\n'

      for (const config of [tsconfig, exact])
        expect(await withExtra(`${head}Strict({...rest} class={{ on: rest.id === 'x' }})\n`, config)).toEqual([expect.stringContaining('class')])
    })

    it('leaves a component with no class prop and a plain element alone', async () => {
      const head = '---\nimport Bare from \'../bare.kay\'\n---\n'

      expect(await withExtra(`${head}div.mt-4(class={{ on: true }}) a\n`, exact)).toEqual([])
      expect(await withExtra(`${head}Bare.mt-4(class={{ on: true }})\n`, exact)).toEqual([])
    })
  })

  it('reads a condition object with a string-typed value beside a shorthand as a parts object, which the docs say', async () => {
    expect(await problems(`${IMPORTS}Plain.mt-4(class={{ 'p-4': rest.id }})\n`)).toEqual([expect.stringContaining('cannot be merged')])
  })
})
