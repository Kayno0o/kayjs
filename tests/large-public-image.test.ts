import { mkdir, symlink, writeFile } from 'node:fs/promises'
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

const found = async (dir: string, lints?: object, base?: string) => (await writeShadowTypes(dir, { routes: 'src/routes', lints, base })).problems.filter(problem => problem.code === 'large-public-image')

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

  async function bare(files: Record<string, string>, base?: string) {
    const dir = await scratchDir('large-public-image-')

    await mkdir(join(dir, 'src', 'routes'), { recursive: true })
    await mkdir(join(dir, 'src', 'components'), { recursive: true })
    await mkdir(join(dir, 'public'), { recursive: true })
    await writeFile(join(dir, 'public', 'my photo.jpg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))
    await writeFile(join(dir, 'public', 'big.jpg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))

    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text)
    }

    return found(dir, undefined, base)
  }

  it('matches a src encoded differently from the file url', async () => {
    const problems = await bare({ 'src/routes/index.kay': ['img(src="/my%20photo.jpg" alt="a")', 'img(src="/my photo.jpg" alt="b")', 'img(src="/big%2Ejpg" alt="c")', 'img(src="/%E0%A4%A.jpg" alt="malformed")', ''].join('\n') })

    expect(problems.map(problem => problem.line)).toEqual([1, 2, 3])
  })

  it('matches a src written with or without the base, and no other host or relative path', async () => {
    const page = ['img(src="/big.jpg" alt="a")', 'img(src="/docs/big.jpg" alt="b")', 'img(src="/docs/docs/big.jpg" alt="c")', 'img(src="https://example.com/big.jpg" alt="d")', 'img(src="//example.com/big.jpg" alt="e")', 'img(src="../big.jpg" alt="f")', 'img(src="big.jpg" alt="g")', 'img(src="/other/big.jpg" alt="h")', ''].join('\n')
    const problems = await bare({ 'src/routes/index.kay': page }, '/docs')

    expect(problems.map(problem => problem.line)).toEqual([1, 2])
  })

  it('reads a layout and a component template too', async () => {
    const problems = await bare({ 'src/routes/layout.kay': 'img(src="/docs/big.jpg" alt="a")\n', 'src/components/Hero.kay': 'img(src="/my%20photo.jpg" alt="a")\n', 'src/routes/index.kay': 'p hi\n' }, '/docs')

    expect(problems.map(problem => problem.file.split('/').pop()).toSorted()).toEqual(['Hero.kay', 'layout.kay'])
  })

  it('does not throw on a dangling symlink in public', async () => {
    const dir = await project()

    await symlink(join(dir, 'public', 'gone.jpg'), join(dir, 'public', 'dangling.jpg'))

    expect((await found(dir)).length).toBe(2)
  })
})
