import { relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { compileKay } from '../src/compiler'
import { unreadSettings } from '../src/server/routes'
import { scratchDir } from './scratch'

const API_OBJECT = /\bapi\s*\(\s*\{/
const messages = (source: string) => compileKay(source, 'page.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.message)
const SETTING = (key: string) => `kay reads \`${key}\` as a literal \`true\` or \`false\``

describe('unreadSettings', () => {
  it.each([
    ['a value held in a variable', 'const open = false\nexport const page = { guards: open }\n', undefined, ['guards']],
    ['a negated value', 'export const page = { guards: !protect }\n', undefined, ['guards']],
    ['a shorthand property', 'export default api({ guards })\n', API_OBJECT, ['guards']],
    ['a spread, which may carry either key', 'export const page = { ...settings, noindex: true }\n', undefined, ['...']],
    ['a computed key', 'export const page = { [\'layouts\']: false }\n', undefined, ['...']],
    ['an expression starting with a literal', 'export const page = { layouts: false || open }\n', undefined, ['layouts']],
    ['a quoted key', 'export const page = { \'layouts\': flag }\n', undefined, ['layouts']],
    ['a method', 'export const page = { guards() { return false } }\n', undefined, ['guards']],
  ])('finds %s', (_name, source, head, keys) => {
    const found = unreadSettings(source, head)

    expect(found.map(({ key }) => key)).toEqual(keys)
    expect(found.every(({ index }) => index >= source.indexOf('{'))).toBe(true)
  })

  it.each([
    ['literals', 'export const page = { guards: false, layouts: true }\n', undefined],
    ['a literal past a comment', 'export const page = { guards: /* open */ false, // why\n layouts: false }\n', undefined],
    ['other keys holding anything', 'export const page = { noindex: flag, revalidate: compute() }\n', undefined],
    ['a nested key of the same name', 'export const page = { sitemap: { guards: flag } }\n', undefined],
    ['an object that is not the page', 'const other = { guards: flag }\n', undefined],
    ['a page written in a comment', '// export const page = { guards: flag }\n', undefined],
    ['an api object with a literal', 'export default api({ cors: { origins: [] }, guards: false })\n', API_OBJECT],
  ])('leaves %s', (_name, source, head) => {
    expect(unreadSettings(source, head)).toEqual([])
  })
})

describe('a guards or layouts setting kay cannot read', () => {
  it.each([
    ['a variable', 'const open = false\nexport const page = { guards: open }', 'guards'],
    ['a negation', 'export const page = { guards: !protect }', 'guards'],
    ['a variable for layouts', 'const bare = true\nexport const page = { layouts: bare }', 'layouts'],
    ['a call', 'export const page = { layouts: pick() }', 'layouts'],
  ])('is reported in a page for %s', (_name, fence, key) => {
    expect(messages(`--- server\n${fence}\n---\np x`)).toEqual([SETTING(key)])
  })

  it('is reported in a layout, at the setting', () => {
    const source = '--- server\nconst open = false\nexport const page = { noindex: true, guards: open }\n---\nslot'
    const [found] = compileKay(source, '_layout.kay', { check: true }).diagnostics

    expect(found?.message).toBe(SETTING('guards'))
    expect(source.slice(found!.start, found!.end)).toBe('open')
  })

  it('is reported for a spread, which may carry either key', () => {
    expect(messages('--- server\nexport const page = { ...settings }\n---\np x')).toEqual(['kay reads each setting of `page` as written'])
  })

  it.each([
    'export const page = { guards: false }',
    'export const page = { guards: true, layouts: false }',
    'const flag = true\nexport const page = { noindex: flag }',
  ])('is not reported for %s', (fence) => {
    expect(messages(`--- server\n${fence}\n---\np x`)).toEqual([])
  })
})

describe('kay check', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await scratchDir('open-settings-')
    await Promise.all([
      Bun.write(`${dir}/routes/index.kay`, 'h1 Home\n'),
      Bun.write(`${dir}/routes/login.kay`, '--- server\nconst open = false\nexport const page = { guards: open }\n---\nh1 Login\n'),
      Bun.write(`${dir}/routes/area/_layout.kay`, '--- server\nexport const page = { layouts: !wrapped }\nconst wrapped = true\n---\nslot\n'),
      Bun.write(`${dir}/routes/area/index.kay`, 'h1 Area\n'),
      Bun.write(`${dir}/routes/feed.json.ts`, 'const open = false\nexport const page = { guards: open }\nexport function GET() {\n  return \'items\'\n}\n'),
      Bun.write(`${dir}/routes/ping.json.ts`, 'export const page = { ...base, noindex: true }\nexport function GET() {\n  return \'pong\'\n}\n'),
      Bun.write(`${dir}/routes/ok.json.ts`, 'export const page = { guards: false }\nexport function GET() {\n  return \'ok\'\n}\n'),
      Bun.write(`${dir}/api/notes.ts`, 'import { api } from \'kay/server\'\n\nconst guards = false\n\nexport default api({ guards }).get(\'/\', () => [])\n'),
      Bun.write(`${dir}/api/health.ts`, 'import { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', () => \'up\')\n'),
    ])
  })

  afterAll(async () => {
    await Bun.$`rm -rf ${dir}`.quiet()
  })

  it('reports each one at its line, in a page, a layout, an endpoint and an api module', async () => {
    const { problems, diagnostics } = await writeShadowTypes(dir, { routes: 'routes', api: 'api' })
    const reported = [
      ...problems.filter(found => found.message.startsWith('kay reads')).map(found => [relative(dir, found.file), found.line, found.message]),
      ...diagnostics.filter(found => found.message.startsWith('kay reads')).map(found => [found.message]),
    ]

    expect(reported.filter(([file]) => String(file).endsWith('.ts')).toSorted()).toEqual([
      ['api/notes.ts', 5, SETTING('guards')],
      ['routes/feed.json.ts', 2, SETTING('guards')],
      ['routes/ping.json.ts', 1, 'kay reads each setting of `page` as written'],
    ])
    expect(reported.filter(([file]) => !String(file).endsWith('.ts')).map(([message]) => message).toSorted()).toEqual([SETTING('guards'), SETTING('layouts')])
  })
})
