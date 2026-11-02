import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { imagePrefixes, keepReplyImages } from '../src/reply-images'

const site = await testSite({ root: join(import.meta.dir, 'fixture') })

afterAll(async () => site.close())

const imagesOf = (html: string) => [...html.matchAll(/<img [^>]*>/g)].map(match => match[0])

it('a reply shows an image under a path of images and leaves out one on a foreign host or another path', async () => {
  const html = await (await site.fetch('/imaging')).text()

  expect(imagesOf(html)).toEqual(['<img src="/files/chart.png?v=1&amp;w=2" alt="chart">'])
  expect(html.slice(0, html.indexOf('data-props'))).not.toContain('evil.example')
  expect(html.slice(html.indexOf('</slot>') - 800)).not.toContain('evil.example')
})

it('a reply shows no image when the Chat sets no images', async () => {
  const html = await (await site.fetch('/not-imaging')).text()

  expect(html).toContain('Not imaging')
  expect(imagesOf(html)).toEqual([])
})

it('keeps only the images under a prefix that is a path of the site, whole segments only, with no dot segment', () => {
  const html = '<p><img src="/files/a.png" alt="a"> <img src="/files-private/a.png" alt="b"> <img src="https://x.example/files/a.png" alt="c"> <img src="/files/./a.png" alt="d"> <img src="/charts/b.png" alt="e"> <img alt="f"></p>'

  expect(imagesOf(keepReplyImages(html, imagePrefixes(['/files', '/charts/'])))).toEqual(['<img src="/files/a.png" alt="a">', '<img src="/charts/b.png" alt="e">'])
  expect(imagesOf(keepReplyImages(html, imagePrefixes(['//x.example', 'files', 'https://x.example', '/a\\b'])))).toEqual([])
  expect(imagePrefixes(undefined)).toEqual([])
  expect(imagePrefixes('/files')).toEqual(['/files/'])
})
