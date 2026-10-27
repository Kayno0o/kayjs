import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, spyOn } from 'bun:test'
import { unknownToolLabels } from '../src/check/tool-labels'
import { scratchDir } from './scratch'

async function found(files: Record<string, string>, lints?: Record<string, string>) {
  const root = await scratchDir('tool-labels-')

  await Promise.all(Object.entries({ 'tsconfig.json': '{}', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  try {
    return (await unknownToolLabels(root, { lints })).map(item => [item.file.split('/').pop(), item.line, item.message.match(/names `([^`]+)`/)![1]])
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const ACTIONS = '--- server\nimport { action, s } from \'kay\'\nexport const homeState = action(s.Object({}), () => \'lit\', { tool: { readOnly: true } })\nexport const setLight = action(s.Object({}), () => \'ok\', { tool: { name: \'light\' } })\n---\n'
const page = (labels: string) => `--- server\nimport { homeState } from './_actions.kay'\n--- script\nimport Chat from '@kaynooo/kayjs-ai/chat.kay'\n---\nChat(action={homeState} toolLabels={${labels}})\n`

it('flags a key that names no tool, and accepts the snake case of an export, a tool name and a numbered twin', async () => {
  const problems = await found({ 'src/routes/_actions.kay': ACTIONS, 'src/routes/index.kay': page('{ home_state: \'Read the home\', light: \'Set the light\', set_light_2: \'x\', \'home_stat\': \'typo\', gone: \'Gone\' }') })

  expect(problems).toEqual([['index.kay', 6, 'home_stat'], ['index.kay', 6, 'gone']])
})

it('takes the name of a function tool written as a string anywhere in the project', async () => {
  const problems = await found({ 'src/tools.ts': 'export const find = tool({ name: \'find_article\', description: \'x\' })\n', 'src/routes/index.kay': page('{ find_article: \'Searched\' }') })

  expect(problems).toEqual([])
})

it('reads only an object literal and honours the lint level', async () => {
  expect(await found({ 'src/routes/index.kay': page('labels') })).toEqual([])
  expect(await found({ 'src/routes/index.kay': page('{ nope: \'x\' }') }, { 'unknown-tool-label': 'allow' })).toEqual([])
  expect(await found({ 'src/routes/index.kay': page('{ nope: \'x\' }') })).toEqual([['index.kay', 6, 'nope']])
})

it('reads no module but the pages when none writes toolLabels', async () => {
  const read = spyOn(Bun, 'file')

  try {
    expect(await found({ 'src/tools.ts': 'export const find = 1\n', 'src/routes/index.kay': '--- server\nconst x = 1\n---\ndiv(x)\n' })).toEqual([])
    expect(read.mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.ts') && path.includes('tool-labels-'))).toEqual([])
  }
  finally {
    read.mockRestore()
  }
})
