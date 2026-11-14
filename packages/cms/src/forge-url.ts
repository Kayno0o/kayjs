import type { FileSaver } from './files'
import { configError } from 'kay/library'
import { forgejo } from './files'
import { github } from './github'
import { gitlab } from './gitlab'

const SCHEME = /^(forgejo|github|gitlab):\/\/(.*)$/i
const TRAILING = /(?:\.git)?\/*$/

const USAGE = {
  forgejo: 'forgejo://TOKEN@git.example.com/owner/repo',
  github: 'github://TOKEN@owner/repo',
  gitlab: 'gitlab://TOKEN@group/project',
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    throw configError('cms', 'CMS_URL', 'CMS_URL has a malformed percent-encoding: write special characters of the token percent-encoded, as %2F for / and %40 for @')
  }
}

// Whether `CMS_URL` names a forge, by its scheme.
export function isForgeUrl(value: string): boolean {
  return SCHEME.test(value)
}

// The forge `CMS_URL` names, as mail's `MAIL_URL` names a provider: `forgejo://TOKEN@git.example.com/owner/repo`, `github://TOKEN@owner/repo` and `gitlab://TOKEN@group/project`, the token percent-encoded. A query sets the rest: `?branch=` for the branch committed to, the repository's default when left out, and `?baseUrl=` for the address of the forge, which a Forgejo takes from the host (https), a GitHub Enterprise Server from its API (`https://github.example.com/api/v3`) and a self-managed GitLab from its address.
export function forgeFromUrl(value: string): FileSaver {
  const match = SCHEME.exec(value)

  if (match === null)
    throw configError('cms', 'CMS_URL', 'CMS_URL is no forge: write it as forgejo://TOKEN@git.example.com/owner/repo, github://TOKEN@owner/repo or gitlab://TOKEN@group/project')

  const kind = match[1]!.toLowerCase() as keyof typeof USAGE
  const [authority = '', query = ''] = match[2]!.split('?', 2)
  const at = authority.indexOf('@')
  const options = new URLSearchParams(query)

  if (at < 1 || at === authority.length - 1)
    throw configError('cms', 'CMS_URL', `CMS_URL is no ${kind} address: write it as ${USAGE[kind]}, the token percent-encoded`)

  const token = decoded(authority.slice(0, at))
  const path = authority.slice(at + 1).replace(TRAILING, '')
  const branch = options.get('branch') ?? undefined
  const given = options.get('baseUrl') ?? undefined

  if (kind === 'forgejo') {
    const slash = path.indexOf('/')
    const repo = path.slice(slash + 1)

    if (slash < 1 || repo.split('/').length !== 2 || repo.startsWith('/'))
      throw configError('cms', 'CMS_URL', `CMS_URL is no Forgejo address: write it as ${USAGE.forgejo}`)

    return forgejo({ baseUrl: given ?? `https://${path.slice(0, slash)}`, repo, token, branch })
  }

  if (kind === 'github') {
    if (path.split('/').length !== 2 || path.startsWith('/') || path.endsWith('/'))
      throw configError('cms', 'CMS_URL', `CMS_URL is no GitHub address: write it as ${USAGE.github}`)

    return github({ baseUrl: given, repo: path, token, branch })
  }

  if (!path.includes('/') || path.startsWith('/'))
    throw configError('cms', 'CMS_URL', `CMS_URL is no GitLab address: write it as ${USAGE.gitlab}, the project's path with its groups`)

  return gitlab({ baseUrl: given, repo: path, token, branch })
}
