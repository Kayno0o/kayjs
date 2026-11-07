import { readFileSync } from 'node:fs'

// Apart from `./endpoints` so `kay check` reads an endpoint file's exports without loading the server.
// The methods an endpoint file may export a handler for, in the order `Allow` lists them.
export const ENDPOINT_VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

export type EndpointVerb = (typeof ENDPOINT_VERBS)[number]

const VERBS: ReadonlySet<string> = new Set(ENDPOINT_VERBS)
// The exports of an endpoint file that are no method: its settings.
const SETTINGS = new Set(['page'])
const scanner = new Bun.Transpiler({ loader: 'ts' })

export function isEndpointVerb(name: string): name is EndpointVerb {
  return VERBS.has(name)
}

// The names a source exports.
export function exportedNames(source: string): string[] {
  return scanner.scan(source).exports
}

// The exports that are neither a method nor `page`, each with the method it was probably meant to be.
export function strayExports(names: readonly string[]): { name: string, meant: EndpointVerb | undefined }[] {
  return names.filter(name => !VERBS.has(name) && !SETTINGS.has(name)).map(name => ({ name, meant: ENDPOINT_VERBS.find(verb => verb === name.toUpperCase()) }))
}

// What `Allow` lists for the methods a file serves: HEAD comes with GET, and OPTIONS is always answered.
export function allowedVerbs(served: Iterable<string>): EndpointVerb[] {
  const own = new Set(served)

  return ENDPOINT_VERBS.filter(verb => own.has(verb) || verb === 'OPTIONS' || (verb === 'HEAD' && own.has('GET')))
}

// The methods an endpoint file exports, read from its source.
export function fileVerbs(file: string): EndpointVerb[] {
  try {
    return exportedNames(readFileSync(file, 'utf8')).filter(isEndpointVerb)
  }
  catch {
    return []
  }
}
