import { describe, expect, it } from 'bun:test'
import { brokenLinks } from '../scripts/links'
import { ARCHIVES, releasePages } from '../scripts/whats-new'
import { renderMarkdown } from '../src/content/markdown'

const read = async (path: string) => Bun.file(path).text()

describe('the release\'s link check', () => {
  it('names the file and anchor of a link the moved or trimmed pages leave dangling', async () => {
    const islands = (await read('llms/islands.md')).replace('# ', '[Gone](upgrading.md#a-section-the-release-dropped)\n\n# ')
    const upgrading = await read('llms/upgrading.md')

    expect(await brokenLinks()).toEqual([])
    expect(await brokenLinks(new Map([['llms/islands.md', islands]]))).toEqual(['llms/islands.md: /llms/upgrading#a-section-the-release-dropped'])
    expect(await brokenLinks(new Map([['llms/islands.md', islands], ['llms/upgrading.md', `${upgrading}\n## A section the release dropped\n`]]))).toEqual([])
  })

  it('refuses a link into an archive by anchor, as the archive loses its oldest sections at a release', async () => {
    const archive = await read('llms/upgrading-archive.md')
    const anchor = (await renderMarkdown(archive)).headings.at(-1)!.id
    const islands = (await read('llms/islands.md')).replace('# ', `[Old](upgrading-archive.md#${anchor})\n\n# `)
    const broken = await brokenLinks(new Map([['llms/islands.md', islands]]))

    expect(broken).toHaveLength(1)
    expect(broken[0]).toStartWith(`llms/islands.md: upgrading-archive.md#${anchor}`)
  })

  it('finds no broken link in the pages the next release writes', async () => {
    const paths = ARCHIVES.flat()
    const texts = new Map<string, string>(await Promise.all(paths.map(async path => [path, await read(path)] as const)))

    expect(await brokenLinks(releasePages(path => texts.get(path)!, '9.9.9'))).toEqual([])
  })
})
