import type { TestSite } from '../src/test'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { deriveToolOutputs } from '../src/check/tool-outputs'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const SUMMARY = {
  type: 'object',
  properties: { count: { type: 'number' }, at: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['count', 'at', 'tags'],
}

// A process serves one project, and its sites read the output folder it has: the record is made once the first test asks.
const dir = join(process.cwd(), await fixtureCopy('tool-outputs'))
const dev = await testSite({ root: dir, mcp: true, islands: false, dev: true })
const opened: TestSite[] = [dev]

afterAll(async () => {
  await Promise.all(opened.map(async site => site.close()))
})

const schemaOf = async (site: TestSite, name: string) => ((await site.mcp.tools()).find(tool => tool.name === name) as { outputSchema?: object } | undefined)?.outputSchema

async function siteAfterBuild(options: { base?: string } = {}): Promise<TestSite> {
  const site = await testSite({ root: dir, mcp: true, islands: false, ...options })

  opened.push(site)

  return site
}

describe('the tools a server lists with a derived schema', () => {
  it('lists none while no record exists, and the schema once kay dev records it, without a restart', async () => {
    expect(await schemaOf(dev, 'summary')).toBeUndefined()
    await deriveToolOutputs(dir, {}, outputDir(dir))
    expect(await schemaOf(dev, 'summary')).toEqual(SUMMARY)
  })

  it('lists the derived outputSchema of a server started from the build, keeps a declared output over it, and sends the structured content', async () => {
    const site = await siteAfterBuild()

    expect(await schemaOf(site, 'summary')).toEqual(SUMMARY)
    expect(Object.keys(((await schemaOf(site, 'declared')) as { properties: object }).properties)).toEqual(['count'])
    expect(await schemaOf(site, 'plain')).toBeUndefined()
    // A tool wording its answer sends that text alone.
    expect(await schemaOf(site, 'worded')).toBeUndefined()
    expect(await site.mcp.call('worded')).toMatchObject({ text: '2 things', data: undefined })
    expect(await schemaOf(site, 'stream')).toBeUndefined()
    expect(await schemaOf(site, 'refuses')).toBeUndefined()
    expect(await site.mcp.call('summary')).toMatchObject({ isError: false, data: { count: 2, at: '1970-01-01T00:00:00.000Z', tags: ['a'] } })
  })

  it('lists it under a base too', async () => {
    const site = await siteAfterBuild({ base: '/shop' })

    expect(await schemaOf(site, 'summary')).toEqual(SUMMARY)
    expect(await site.mcp.call('summary')).toMatchObject({ data: { count: 2 } })
  })
})
