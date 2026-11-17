import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/share-target', islands: false, assets: { manifest: { scope: '/', shareTarget: { action: 'src/routes/share.kay#receive', files: ['image/*', '.pdf'] } } } })

afterAll(async () => {
  await site.close()
})

async function manifest(): Promise<{ share_target: { action: string, method: string, enctype: string, params: Record<string, unknown> } }> {
  return await (await site.fetch('/manifest.webmanifest')).json() as never
}

describe('the manifest\'s share target', () => {
  it('names the action, posts multipart when files are taken and lists their kinds', async () => {
    expect((await manifest()).share_target).toEqual({ action: '/_kay/action/src/routes/share.kay/receive', method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['image/*', '.pdf'] }] } })
  })

  it('reaches the action with a share as a device posts it, title, text, link and files', async () => {
    const { action } = (await manifest()).share_target
    const body = new FormData()

    body.set('title', 'A page')
    body.set('text', 'Worth a read')
    body.set('url', 'https://example.com/a')
    body.append('files', new File(['hello'], 'note.pdf', { type: 'application/pdf' }))

    const response = await site.fetch(action, { method: 'POST', body, headers: { 'sec-fetch-site': 'none' }, redirect: 'manual' })
    const query = new URL(response.headers.get('location')!, 'http://localhost').searchParams

    expect(response.status).toBe(303)
    expect(Object.fromEntries(query)).toEqual({ title: 'A page', text: 'Worth a read', url: 'https://example.com/a', files: 'note.pdf:5' })
  })

  it('takes a share of a link alone, posted as a form', async () => {
    const { action } = (await manifest()).share_target
    const response = await site.fetch(action, { method: 'POST', body: new URLSearchParams({ url: 'https://example.com/b' }), headers: { 'sec-fetch-site': 'none' }, redirect: 'manual' })

    expect(Object.fromEntries(new URL(response.headers.get('location')!, 'http://localhost').searchParams)).toMatchObject({ url: 'https://example.com/b', title: '', files: '' })
  })
})
