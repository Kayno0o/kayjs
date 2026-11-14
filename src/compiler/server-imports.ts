import type { Diagnostic, KayFile } from './ast'
import type { ScriptAnalysis, ServerAnalysis } from './script'
import type { ImportBinding } from './script-shared'
import { templateExpressions } from './browser'

const WORD = /(?<![\w$.])[a-z_$][\w$]*/gi

// The statement that brings a binding into the script fence.
function importLine(binding: ImportBinding): string {
  const source = JSON.stringify(binding.source).replaceAll('"', '\'')

  if (binding.imported === 'default')
    return `import ${binding.local} from ${source}\n`

  if (binding.imported === '*')
    return `import * as ${binding.local} from ${source}\n`

  return `import { ${binding.imported === binding.local ? binding.local : `${binding.imported} as ${binding.local}`} } from ${source}\n`
}

// A name a page's template reads that only its `--- server` fence imports, where the page hydrates: the browser runs the template without that fence, so the read throws there.
// The fix copies the import into the script fence, offered and never applied, as the module may need the server.
export function serverImportReads(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, island: boolean): Diagnostic[] {
  if (!island || server === undefined)
    return []

  const own = new Set(script.imports.map(binding => binding.local))
  const wanted = new Map(server.imports.filter(binding => !binding.typeOnly && !own.has(binding.local)).map(binding => [binding.local, binding]))

  if (wanted.size === 0)
    return []

  const found: Diagnostic[] = []

  for (const { span } of templateExpressions(file)) {
    for (const match of file.source.slice(span.start, span.end).matchAll(WORD)) {
      const binding = wanted.get(match[0])

      if (binding === undefined)
        continue

      wanted.delete(match[0])
      const start = span.start + match.index
      const fixes = file.script === undefined ? [] : [{ title: 'Import it in the script fence too', edits: [{ start: file.script.start, end: file.script.start, text: importLine(binding) }] }]

      found.push({ start, end: start + match[0].length, message: `\`${match[0]}\` is imported in the \`--- server\` fence, and this page hydrates in the browser, which has no such import`, note: 'the browser runs the template without the server fence, so the read throws there and every island of the page stays inert', help: 'import it in the script fence, or move what reads it into a component', fixes, checkOnly: true })
    }
  }

  return found
}
