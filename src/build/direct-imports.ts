import { dirname, resolve } from 'node:path'

// `kay` and `kay/internal` re-export names of many runtime modules. A bundler puts a module re-exported through a file several entry points import in the chunk they all load, whatever they take from it, so an import of one name from them is pointed at the module holding it: a page then loads the runtime modules its own islands use.
const BARRELS = new Map([['kay', 'src/runtime/index.ts'], ['kay/internal', 'src/runtime/internal.ts']])
const PACKAGE_DIR = resolve(import.meta.dir, '../..')
// A value re-export of a relative module, and a named import from a barrel, on one line or several, in single or double quotes.
const REEXPORT = /^export\s*\{([^}]*)\}\s*from\s*(["'])(\.[^"']*)\2/gm
const STAR_REEXPORT = /^export\s*\*\s*from\s*(["'])(\.[^"']*)\1/gm
const NAMED_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])(kay|kay\/internal)\2[ \t]*;?/g
const ALIAS = /\s+as\s+/
const TYPE_MODIFIER = /^type\s/
const EXTENSIONS = ['', '.ts', '/index.ts']
const transpiler = new Bun.Transpiler({ loader: 'ts' })

interface Source {
  file: string
  local: string
}

const sources = new Map<string, Promise<Map<string, Source>>>()

function moduleFile(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier)

  return EXTENSIONS.map(extension => `${base}${extension}`).find(path => path.endsWith('.ts') && Bun.file(path).size > 0)
}

async function sourcesOf(specifier: string): Promise<Map<string, Source>> {
  const barrel = resolve(PACKAGE_DIR, BARRELS.get(specifier)!)
  const code = await Bun.file(barrel).text()
  const found = new Map<string, Source>()

  for (const name of transpiler.scan(code).exports)
    found.set(name, { file: barrel, local: name })

  for (const [, , from] of code.matchAll(STAR_REEXPORT)) {
    const file = moduleFile(barrel, from!)

    if (file === undefined)
      continue

    for (const name of transpiler.scan(await Bun.file(file).text()).exports)
      found.set(name, { file, local: name })
  }

  for (const [, names, , from] of code.matchAll(REEXPORT)) {
    const file = moduleFile(barrel, from!)

    if (file === undefined)
      continue

    for (const entry of names!.split(',')) {
      const [local, exported = local] = entry.trim().split(ALIAS)

      if (local !== undefined && local !== '' && !TYPE_MODIFIER.test(entry.trim()))
        found.set(exported!, { file, local })
    }
  }

  return found
}

// Rewrites each named import from `kay` and `kay/internal` into imports of the modules holding the names; a name that is not a value the barrel exports stays in an import of the barrel, and a statement of types alone goes.
export async function directImports(code: string): Promise<string> {
  if (!code.includes('kay'))
    return code

  const imports = [...code.matchAll(NAMED_IMPORT)]

  if (imports.length === 0)
    return code

  for (const specifier of BARRELS.keys()) {
    if (!sources.has(specifier))
      sources.set(specifier, sourcesOf(specifier))
  }

  const known = new Map(await Promise.all([...sources].map(async ([specifier, found]) => [specifier, await found] as const)))

  return code.replace(NAMED_IMPORT, (_statement, clause: string, quote: string, specifier: string) => {
    const found = known.get(specifier)!
    const byFile = new Map<string, string[]>()
    const rest: string[] = []

    for (const entry of clause.split(',')) {
      const name = entry.trim()

      if (name === '' || TYPE_MODIFIER.test(name))
        continue

      const [imported, alias = imported] = name.split(ALIAS)
      const source = found.get(imported!)

      if (!source) {
        rest.push(name)

        continue
      }

      const list = byFile.get(source.file) ?? []

      list.push(source.local === alias ? alias : `${source.local} as ${alias}`)
      byFile.set(source.file, list)
    }

    return [
      ...rest.length > 0 ? [`import { ${rest.join(', ')} } from ${quote}${specifier}${quote};`] : [],
      ...[...byFile].map(([file, names]) => `import { ${names.join(', ')} } from ${JSON.stringify(file)};`),
    ].join(' ')
  })
}
