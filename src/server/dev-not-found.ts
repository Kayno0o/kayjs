import type { MissingPath } from './not-found'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isCrossSite } from './actions'
import { missingStore, NOT_FOUND_FILE } from './not-found'
import { addRedirect, answered, checkRedirect } from './not-found-config'

const HEADER = 'x-kay-dev'

// What the dev tool's Not found tab lists: the paths a production run recorded visitors found nothing at, the ones a redirect of the config answers left out.
export interface DevNotFound {
  // The file a production run keeps them in, from the project's root.
  file: string
  // Whether that file exists: `kay dev` records nothing itself.
  recorded: boolean
  missing: MissingPath[]
}

export function devNotFound(root: string, redirects: string[]): DevNotFound {
  const file = join(root, NOT_FOUND_FILE)

  if (!existsSync(file))
    return { file: NOT_FOUND_FILE, recorded: false, missing: [] }

  const store = missingStore(file, false)

  try {
    return { file: NOT_FOUND_FILE, recorded: true, missing: store.list().filter(row => !answered(row.path, redirects)) }
  }
  finally {
    store.close()
  }
}

function refused(error: string, status = 400): Response {
  return Response.json({ error }, { status })
}

// Writes the redirect `kay not-found --redirect` would, from a click on the tab: `path`, and `to` or else the target recorded for it.
export async function devRedirect(root: string, request: Request, redirects: string[]): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  let body: { path?: unknown, to?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return refused('the request holds no JSON')
  }

  if (typeof body.path !== 'string' || (body.to !== undefined && typeof body.to !== 'string'))
    return refused('path and to are texts')

  const file = join(root, NOT_FOUND_FILE)
  const store = existsSync(file) ? missingStore(file, false) : undefined

  try {
    const redirect = body.path
    const target = body.to ?? store?.list().find(row => row.path === redirect)?.target

    if (target === undefined)
      return refused(`${redirect} has no suggested target`)

    checkRedirect(redirect, target, new Set(redirects))

    if (await addRedirect(join(root, 'kay.config.ts'), redirect, target) === 'by hand')
      return refused('kay.config.ts has no `redirects` object literal to add the redirect to: add it by hand')

    store?.forget(redirect)

    return Response.json({ redirect: { from: redirect, to: target } })
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  finally {
    store?.close()
  }
}
