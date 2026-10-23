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

const found = async (dir: string, lints?: object, base?: string, extra: object = {}) => (await writeShadowTypes(dir, { routes: 'src/routes', lints, base, ...extra })).problems.filter(problem => problem.code === 'large-public-image')

const at = (problems: Awaited<ReturnType<typeof found>>) => problems.map(problem => `${problem.file.split('/').pop()}:${problem.line}`).toSorted()

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

  async function bare(files: Record<string, string>, base?: string, extra: object = {}) {
    const dir = await scratchDir('large-public-image-')

    await mkdir(join(dir, 'src', 'routes'), { recursive: true })
    await mkdir(join(dir, 'src', 'components'), { recursive: true })
    await mkdir(join(dir, 'public'), { recursive: true })
    await writeFile(join(dir, 'public', 'my photo.jpg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))
    await writeFile(join(dir, 'public', 'big.jpg'), new Uint8Array(LARGE_IMAGE_BYTES + 1))

    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text)
    }

    return found(dir, undefined, base, extra)
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

  it('also sees a raster in a CSS url(), a style attribute, a social card meta and a Markdown image', async () => {
    const problems = await bare({
      'src/routes/index.kay': ['div(style="background: url(/big.jpg)")', 'div(style="background: url(\'/my%20photo.jpg\')")', 'meta(property="og:image" content="/big.jpg")', 'meta(name="twitter:image" content="/big.jpg?v=2")', 'meta(property="og:title" content="/big.jpg")', 'div(style="background: URL(/big.jpg?v=1#x)")', 'div(style="background: url(/small.jpg)")', 'div(style="background: url(https://example.com/big.jpg)")', ''].join('\n'),
      'src/components/Hero.kay': `div(style='background: image-set(url("/big.jpg") 1x)')\n`,
      'src/styles.css': '/* url(/big.jpg) */\n.a { background: url(/big.jpg) }\n.b { background: url(/missing.jpg) }\n',
      'src/routes/post.md': '![hero](/big.jpg)\n\n![none](/missing.jpg)\n\n![spaced](/docs/big.jpg "title")\n\n`![inline](/big.jpg)`\n\n```md\n![fenced](/big.jpg)\n```\n',
    }, '/docs')

    expect(problems.map(problem => `${problem.file.split('/').pop()}:${problem.line}`).toSorted()).toEqual(['Hero.kay:1', 'index.kay:1', 'index.kay:2', 'index.kay:3', 'index.kay:4', 'index.kay:6', 'post.md:1', 'post.md:5', 'styles.css:2'])
  })

  it('sees an absolute og:image under the site, and no other origin', async () => {
    const problems = await bare({
      'src/routes/index.kay': ['meta(property="og:image" content="https://example.com/docs/big.jpg")', 'meta(property="og:image" content="https://example.com/big.jpg?v=1")', 'meta(property="og:image" content="https://other.com/big.jpg")', 'meta(property="og:image" content="https://example.com.evil.com/big.jpg")', 'img(src="https://example.com/big.jpg" alt="a")', ''].join('\n'),
    }, '/docs', { site: 'https://example.com/' })

    expect(at(problems)).toEqual(['index.kay:1', 'index.kay:2', 'index.kay:5'])
  })

  it('reads seo.image from the config, one text per locale', async () => {
    const one = await bare({ 'kay.config.ts': 'export default {\n  seo: {\n    image: \'/big.jpg\',\n  },\n}\n' }, undefined, { seo: { image: '/big.jpg' } })

    expect(at(one)).toEqual(['kay.config.ts:3'])

    const record = await bare({ 'kay.config.ts': 'export default {\n  seo: {\n    image: { en: \'/big.jpg\', fr: \'/missing.jpg\' },\n  },\n}\n' }, undefined, { seo: { image: { en: '/big.jpg', fr: '/missing.jpg' } } })

    expect(at(record)).toEqual(['kay.config.ts:3'])
    expect(at(await bare({}, undefined, { seo: { image: '/missing.jpg' } }))).toEqual([])
    expect((await bare({}, undefined, { seo: { image: 'https://example.com/big.jpg' }, site: 'https://example.com' })).length).toBe(1)
  })

  it('reads the image field of a Markdown frontmatter', async () => {
    const problems = await bare({
      'src/routes/a.md': '---\ntitle: A\nimage: /big.jpg\n---\n\nBody\n',
      'src/routes/b.md': '---\ntitle: B\nimage: "/my%20photo.jpg"\n---\n',
      'src/routes/c.md': '---\ntitle: C\nimage: /missing.jpg\n---\n',
      'src/routes/d.md': 'image: /big.jpg\n',
      'src/routes/e.md': '---\ntitle: E\ncover: /big.jpg\n---\n\n    image: /big.jpg\n',
    })

    expect(at(problems)).toEqual(['a.md:3', 'b.md:3'])
  })

  it('sees an HTML img and a reference-style image in Markdown, and a bare string in image-set()', async () => {
    const problems = await bare({
      'src/routes/post.md': ['<img src="/big.jpg" alt="a">', '<img alt="b" src=\'/my%20photo.jpg\'>', '<img src="/big.jpg" srcset="/big.jpg 1x" alt="c">', '<IMG SRC=/big.jpg>', '', '![ref][hero] ![collapsed][] ![shortcut] ![none][nope] ![missing][gone]', '', '[hero]: /big.jpg "Title"', '[collapsed]: </my%20photo.jpg>', '[shortcut]: /big.jpg', '[none]: /missing.jpg', ''].join('\n'),
      'src/styles.css': '.a { background: image-set("/big.jpg" 1x, "/missing.jpg" 2x) }\n.b { background: image-set(url("/big.jpg") 1x, \'/my%20photo.jpg\' 2x) }\n.c { background: image-set(url(/missing.jpg) 1x) }\n',
    })

    expect(at(problems)).toEqual(['post.md:1', 'post.md:2', 'post.md:4', 'post.md:6', 'post.md:6', 'post.md:6', 'styles.css:1', 'styles.css:2', 'styles.css:2'])
  })

  it('skips ~~~ fences and indented code in Markdown, but not a list continuation', async () => {
    const problems = await bare({
      'src/routes/post.md': ['~~~md', '![a](/big.jpg)', '~~~', '', '````md', '```', '![b](/big.jpg)', '````', '', 'Text', '', '    ![c](/big.jpg)', '', '\t![d](/big.jpg)', '', 'A paragraph', '    ![e](/big.jpg)', '', '- item', '', '    ![f](/big.jpg)', '', '![g](/big.jpg)', ''].join('\n'),
    })

    expect(at(problems)).toEqual(['post.md:17', 'post.md:21', 'post.md:23'])
  })

  it('skips a fence nested in a list item or a blockquote, code after a heading or a fence, and an HTML comment', async () => {
    const problems = await bare({
      'src/routes/post.md': ['- item', '', '    ```', '    ![a](/big.jpg)', '    ```', '', '> ```', '> ![b](/big.jpg)', '> ```', '', '1. one', '   - two', '', '     ~~~', '     ![c](/big.jpg)', '     ~~~', '', '# Heading', '    ![d](/big.jpg)', '', '```', 'x', '```', '    ![e](/big.jpg)', '', '<!-- ![f](/big.jpg) -->', '', '![g](/big.jpg)', '', 'Para', '', '    ```', '', '![i](/big.jpg)', ''].join('\n'),
      'src/routes/doc.mdx': 'Text\n\n    ![h](/big.jpg)\n',
    })

    expect(at(problems)).toEqual(['doc.mdx:3', 'post.md:28', 'post.md:34'])
  })

  it('closes a nested fence only on a fence line under its own container', async () => {
    const problems = await bare({
      'src/routes/post.md': ['> ```', '> ![a](/big.jpg)', '> - ```', '> ![b](/big.jpg)', '```', '', '- ```', '  ![c](/big.jpg)', '  > ```', '  ![d](/big.jpg)', '  ```', '', '![e](/big.jpg)', ''].join('\n'),
    })

    expect(at(problems)).toEqual(['post.md:13'])
  })

  it('measures a fence container by tab stops and keeps a quote inside a list item', async () => {
    const problems = await bare({
      'src/routes/post.md': ['-\t```', '\t![a](/big.jpg)', '\t```', '', '- > ```', '  > ![b](/big.jpg)', '  > ```', '', '- > ```', '> ![c](/big.jpg)', '', '![d](/big.jpg)', '', '> - > ```', '>   > ![e](/big.jpg)', '>   > ```', '> ![f](/big.jpg)', ''].join('\n'),
    })

    expect(at(problems)).toEqual(['post.md:10', 'post.md:12', 'post.md:17'])
  })

  it('reads an HTML img by its own attributes, a nested bracket alt and the first reference definition', async () => {
    const problems = await bare({
      'src/routes/post.md': ['<img data-src="/big.jpg" src="/missing.jpg">', '<img alt="a > b src=/missing.jpg" src="/big.jpg">', '<img alt=don\'t src="/big.jpg">', '![a [b] c](/big.jpg)', '![ref][Two  Words]', '', '[two words]: /big.jpg', '[two words]: /missing.jpg', ''].join('\n'),
    })

    expect(at(problems)).toEqual(['post.md:2', 'post.md:3', 'post.md:4', 'post.md:5'])
  })

  it('blanks a CSS comment in a Markdown style block and keeps /* inside a url()', async () => {
    const problems = await bare({
      'src/routes/post.md': ['<style>', '/* .a { background: url(/big.jpg) } */', '.b { background: url(/a/*.jpg), url(/big.jpg) /* c */ }', '</style>', '', 'A /* ![x](/big.jpg) */ prose.', ''].join('\n'),
      'src/styles.css': '.a { background: url(/a/*.jpg), url(/big.jpg) /* c */ }\n',
      'src/routes/index.kay': ['div(style="/* url(/big.jpg) */")', 'div(style="background: url(/a/*.jpg), url(/big.jpg) /* c */")', ''].join('\n'),
    })

    expect(at(problems)).toEqual(['index.kay:2', 'post.md:3', 'post.md:6', 'styles.css:1'])
  })

  it('does not throw on a dangling symlink in public', async () => {
    const dir = await project()

    await symlink(join(dir, 'public', 'gone.jpg'), join(dir, 'public', 'dangling.jpg'))

    expect((await found(dir)).length).toBe(2)
  })
})
