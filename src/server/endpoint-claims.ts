import type { Endpoint } from './routes'
import type { ServedPaths } from './served-paths'
import { fileVerbs } from './endpoint-verbs'

// Apart from `./endpoints` so `kay check` claims the paths without loading the server.
// Two endpoints serving the same paths, or one taking a path a page or a public file serves, stop the server, as two pages do; each is exported as `exportedEndpoints` says.
export function claimEndpoints(served: ServedPaths, endpoints: Endpoint[], root: string): void {
  for (const endpoint of endpoints) {
    const { pattern, suffix, file } = endpoint
    const path = `${pattern}${suffix ?? ''}`

    const exported = async () => (await (await import('./endpoints')).exportedEndpoints(root, [endpoint])).paths

    // A claim per method it answers.
    for (const method of methodsClaimed(file)) {
      served.claim({ path: pattern, owner: file, kind: 'endpoint', suffix, method, ...method === 'GET' && { exported } }, (taken) => {
        if (taken.kind === 'page')
          return `kay: ${taken.owner} and ${file} both serve ${pattern}${suffix === undefined ? '' : `, which ${file} takes for its paths ending in ${suffix}`}; move one`

        return taken.kind === 'public' ? `kay: ${file} and the public file ${taken.path} both serve ${path}; drop one` : `kay: ${taken.owner} and ${file} both serve ${method === 'GET' ? '' : `${method} `}${path}`
      })
    }
  }
}

// GET always, as the server registers it for the 405 of a file that lacks one; HEAD comes with GET and OPTIONS is the file's to answer.
function methodsClaimed(file: string): string[] {
  return ['GET', ...fileVerbs(file).filter(verb => verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS')]
}
