import type { KayExtension } from 'kay/server'
import { Elysia } from 'elysia'
import { nameUser } from 'kay/library'

// The catalogs kayjs-ui ships, which an installed app gets through the library's package.json.
export function uiMessages(): KayExtension {
  return { name: 'ui-messages', messages: `${import.meta.dir}/../../../../packages/ui/src/messages` }
}

// Who is signed in, standing in for kayjs-auth: a header names the visitor of a request, else the name a test set for every request.
export const visitor: { name: string | undefined } = { name: undefined }

export function who(): KayExtension {
  return {
    name: 'who',
    server: new Elysia().derive({ as: 'global' }, ({ request }) => {
      nameUser(request, () => request.headers.get('x-user') ?? visitor.name)

      return {}
    }),
  }
}
