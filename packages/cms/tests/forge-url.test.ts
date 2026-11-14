import { describe, expect, test } from 'bun:test'
import { forgeFromUrl, isForgeUrl } from '../src/forge-url'

describe('CMS_URL', () => {
  test('names a Forgejo by its host, a GitHub and a GitLab by their repository', () => {
    expect(isForgeUrl('forgejo://t@git.example.com/team/site')).toBe(true)
    expect(isForgeUrl('smtp://host')).toBe(false)

    for (const url of ['forgejo://t@git.example.com/team/site', 'github://t@team/site?branch=content', 'gitlab://t@team/sub/site', 'github://t@team/site?baseUrl=https://ghe.example.com/api/v3', 'gitlab://t@team/site.git/?baseUrl=https://gitlab.example.com'])
      expect(typeof forgeFromUrl(url).save).toBe('function')
  })

  test('commits to the repository, branch and token it names, with the token percent-encoded', async () => {
    const posted: { path: string, token: string | null, branch: string | undefined }[] = []
    const forge = Bun.serve({ port: 0, fetch: async (request) => {
      if (request.method !== 'POST')
        return new Response(null, { status: 404 })

      posted.push({ path: new URL(request.url).pathname, token: request.headers.get('authorization'), branch: ((await request.json()) as { branch?: string }).branch })

      return Response.json({ commit: { sha: 'abc' } })
    } })

    try {
      const saver = forgeFromUrl(`forgejo://s%40cret%2Fx@git.example.com/team/site?branch=content&baseUrl=http://localhost:${forge.port}`)

      await saver.save({ repoPath: 'src/content/a.md', absolute: '/nowhere/a.md', text: 'hi', message: 'add a' })
      expect(posted).toEqual([{ path: '/api/v1/repos/team/site/contents', token: 'token s@cret/x', branch: 'content' }])
    }
    finally {
      await forge.stop()
    }
  })

  test('refuses what is no forge address, naming CMS_URL and the shape it takes', () => {
    expect(() => forgeFromUrl('https://git.example.com/team/site')).toThrow('CMS_URL is no forge')
    expect(() => forgeFromUrl('forgejo://git.example.com/team/site')).toThrow('CMS_URL is no forgejo address: write it as forgejo://TOKEN@')
    expect(() => forgeFromUrl('forgejo://t@git.example.com/site')).toThrow('CMS_URL is no Forgejo address')
    expect(() => forgeFromUrl('github://t@site')).toThrow('CMS_URL is no GitHub address')
    expect(() => forgeFromUrl('github://t@a/b/c')).toThrow('CMS_URL is no GitHub address')
    expect(() => forgeFromUrl('gitlab://t@site')).toThrow('CMS_URL is no GitLab address')
    expect(() => forgeFromUrl('github://%E0%A4%A@a/b')).toThrow('malformed percent-encoding')
  })
})
