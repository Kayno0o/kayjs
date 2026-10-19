import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { LARGE_IMAGE_BYTES } from '../src/check/large-images'
import { scratchDir } from './scratch'

const page = [
  'img(src="/big.jpg" width="1600" height="900" alt="Big")',
  'img(src="/big.jpg?v=2" width="1600" height="900" alt="Big again")',
  'img(src="/small.png" width="10" height="10" alt="Small")',
  'img(src="/big.svg" width="10" height="10" alt="Vector")',
  'img(src="/big.jpg" srcset="/big.jpg 1x" width="1600" height="900" alt="Own srcset")',
  'img(src={"/big.jpg"} width="1600" height="900" alt="Expression")',
  'Img(src="/big.jpg")',
  '',
].join('\n')

async function project(): Promise<string> {
  const dir = await scratchDir('large-public-image-')

  await mkdir(join(dir, 'src', 'routes'), { recursive: true })
  await mkdir(join(dir, 'public'), { recursive: true })
  await writeFile(join(dir, 'src', 'routes', 'index.kay'), page)
  await writeFile(join(dir, 'public', 'big.jpg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))
  await writeFile(join(dir, 'public', 'big.svg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))
  await writeFile(join(dir, 'public', 'small.png'), new Uint8Array(LARGE_IMAGE_BYTES))

  return dir
}

const found = async (dir: string, lints?: object) => (await writeShadowTypes(dir, { routes: 'src/routes', lints })).problems.filter(problem => problem.code === 'large-public-image')

describe('large-public-image', () => {
  it('warns of an img with a static src naming a public raster over the threshold, and of nothing else', async () => {
    const dir = await project()
    const problems = await found(dir)

    expect(problems.map(problem => [problem.line, problem.severity])).toEqual([[1, 'warning'], [2, 'warning']])
    expect(problems[0]!.message).toContain('/big.jpg')
  })

  it('takes its level from the config', async () => {
    const dir = await project()

    expect((await found(dir, { 'large-public-image': 'deny' })).map(problem => problem.severity)).toEqual(['error', 'error'])
    expect(await found(dir, { 'large-public-image': 'allow' })).toEqual([])
    expect((await found(dir, { performance: 'allow' }))).toEqual([])
  })
})
