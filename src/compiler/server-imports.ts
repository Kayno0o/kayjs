import type { Diagnostic, KayFile } from './ast'
import type { ScriptAnalysis, ServerAnalysis } from './script'
import type { ImportBinding } from './script-shared'
import { templateExpressions } from './browser'
import { visitNodes } from './template-walk'

const NEEDS_ESCAPE = /['\\]/
const WORD = /(?<![\w$.])[a-z_$][\w$]*/gi
// The import a tag names, `forms` of `forms.Field`.
const TAG_ROOT = /^[^.]*/

// The statement that brings a binding into the script fence.
function importLine(binding: ImportBinding): string {
  const source = NEEDS_ESCAPE.test(binding.source) ? JSON.stringify(binding.source) : `'${binding.source}'`

  if (binding.imported === 'default')
    return `import ${binding.local} from ${source}\n`

  if (binding.imported === '*')
    return `import * as ${binding.local} from ${source}\n`

  return `import { ${binding.imported === binding.local ? binding.local : `${binding.imported} as ${binding.local}`} } from ${source}\n`
}

// A `.kay` module compiles to its components and its actions' stubs in the browser, so what a page's server fence imports from one is imported by its island too.
const browserImport = (binding: ImportBinding) => binding.source.endsWith('.kay')

// Each name the template reads that only the `--- server` fence imports, with where it is first read.
function serverFenceReads(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis): { binding: ImportBinding, start: number }[] {
  const own = new Set(script.imports.map(binding => binding.local))
  const wanted = new Map(server.imports.filter(binding => !binding.typeOnly && !own.has(binding.local)).map(binding => [binding.local, binding]))
  const found: { binding: ImportBinding, start: number }[] = []

  if (wanted.size === 0)
    return found

  for (const { span } of templateExpressions(file)) {
    for (const match of file.source.slice(span.start, span.end).matchAll(WORD)) {
      const binding = wanted.get(match[0])

      if (binding === undefined)
        continue

      wanted.delete(match[0])
      found.push({ binding, start: span.start + match.index })
    }
  }

  // A component's tag reads its name too, `Card(...)` or `forms.Field(...)`.
  visitNodes(file.template, (node) => {
    const binding = node.kind === 'element' && node.component ? wanted.get(TAG_ROOT.exec(node.name)![0]) : undefined

    if (binding !== undefined && node.kind === 'element') {
      wanted.delete(binding.local)
      found.push({ binding, start: node.tag.start })
    }
  })

  return found.sort((a, b) => a.start - b.start)
}

// The imports a page's browser module adds for what its template reads from a `.kay` module only the server fence imports, such as another route's action, which the browser takes as that module's stub.
export function browserImports(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis): string {
  return serverFenceReads(file, script, server).filter(({ binding }) => browserImport(binding)).map(({ binding }) => importLine(binding)).join('')
}

// A name a page's template reads that only its `--- server` fence imports, where the page hydrates: the browser runs the template without that fence, so the read throws there. An import of a `.kay` module is left out, as the island imports it too.
// The fix copies the import into the script fence, offered and never applied, as the module may need the server.
export function serverImportReads(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, island: boolean): Diagnostic[] {
  if (!island || server === undefined)
    return []

  const found: Diagnostic[] = []

  for (const { binding, start } of serverFenceReads(file, script, server)) {
    if (browserImport(binding))
      continue

    const name = binding.local
    const fixes = file.script === undefined ? [] : [{ title: 'Import it in the script fence too', edits: [{ start: file.script.start, end: file.script.start, text: importLine(binding) }] }]

    found.push({ start, end: start + name.length, message: `\`${name}\` is imported in the \`--- server\` fence, and this page hydrates in the browser, which has no such import`, note: 'the browser runs the template without the server fence, so the read throws there and every island of the page stays inert', help: 'import it in the script fence, or move what reads it into a component', fixes, checkOnly: true })
  }

  return found
}
