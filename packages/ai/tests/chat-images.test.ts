import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { sanitizeHtml } from 'kay'
import { markdownHtml } from 'kay/markdown'
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

it('keeps only the images under a prefix that is a path of the site, whole segments only', () => {
  const html = '<p><img src="/files/a.png" alt="a"> <img src="/files-private/a.png" alt="b"> <img src="https://x.example/files/a.png" alt="c"> <img src="/files/./a.png" alt="d"> <img src="/charts/b.png" alt="e"> <img alt="f"></p>'

  expect(imagesOf(keepReplyImages(html, imagePrefixes(['/files', '/charts/'])))).toEqual(['<img src="/files/a.png" alt="a">', '<img src="/files/./a.png" alt="d">', '<img src="/charts/b.png" alt="e">'])
  expect(imagesOf(keepReplyImages(html, imagePrefixes(['//x.example', 'files', 'https://x.example', '/a\\b'])))).toEqual([])
  expect(imagePrefixes(undefined)).toEqual([])
  expect(imagePrefixes('/files')).toEqual(['/files/'])
})

it('judges an image by where a browser would request it, through the sanitizer a reply goes through', () => {
  const markdown = ['/files/a.png?q=/../x', '/files/%2e%2e/secret', '/files/%2E./x', '/files/.%2e/x', '/files/..;/x', '/files/a%2fb.png', '/files/sub/../b.png', '/files/%5c..', '/files//x.png', '/files/a.png'].map((src, index) => `![${index}](${src})`).join(' ')
  const sanitized = sanitizeHtml(markdownHtml(markdown), { tags: ['img'], attributes: { img: ['src', 'alt'] }, relativeUrls: true })

  expect(imagesOf(keepReplyImages(sanitized, ['/files/'])).map(tag => (/src="([^"]*)"/).exec(tag)![1])).toEqual(['/files/a.png?q=/../x', '/files/..;/x', '/files/sub/../b.png', '/files//x.png', '/files/a.png'])
})
