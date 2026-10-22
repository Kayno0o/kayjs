import { describe, expect, it } from 'bun:test'
import { importEdits, importSpecifiers, moduleImportEdits } from '../src/lsp/renames'

const MOVES = new Map([['/app/src/card.kay', '/app/src/ui/panel.kay']])

describe('moduleImportEdits', () => {
  it('follows imports, re-exports, dynamic imports and require calls', () => {
    const source = 'import a from \'./card.kay\'\nexport { b } from \'./card.kay\'\nexport * from \'./card.kay\'\nconst c = () => import(\'./card.kay\')\nconst d = require(\'./card.kay\')\nimport \'./card.kay\'\n'

    expect(moduleImportEdits('/app/src/use.ts', source, MOVES).map(edit => edit.text)).toEqual(['./ui/panel.kay', './ui/panel.kay', './ui/panel.kay', './ui/panel.kay', './ui/panel.kay', './ui/panel.kay'])
  })

  it('leaves comments, strings and template literals that only look like imports alone', () => {
    const source = '// import x from \'./card.kay\'\n/* from \'./card.kay\' */\nconst a = \'import "./card.kay"\'\nconst b = `from \'./card.kay\'`\nconst c = { from: \'./card.kay\' }\n'

    expect(moduleImportEdits('/app/src/use.ts', source, MOVES)).toEqual([])
  })

  it('rewrites the imports of a module that moves', () => {
    const moves = new Map([['/app/src/lib/use.ts', '/app/src/lib/deep/use.ts']])
    const edits = moduleImportEdits('/app/src/lib/use.ts', 'import a from \'../card.kay\'\nimport b from \'./sibling\'\n', moves)

    expect(edits.map(edit => edit.text)).toEqual(['../../card.kay', '../sibling'])
  })
})

describe('importSpecifiers', () => {
  it('reads the imports, re-exports and dynamic imports of the script, server and module fences', () => {
    const source = '--- module\nexport { z } from \'./z.kay\'\n--- script\nconst lazy = () => import(\'./lazy.kay\')\n--- server\nimport q from \'./q.ts\'\n---\np hi\n'

    expect(importSpecifiers(source).map(span => source.slice(span.start, span.end))).toEqual(['./lazy.kay', './q.ts', './z.kay'])
  })

  it('leaves bare specifiers alone', () => {
    expect(importEdits('/app/src/a.kay', '---\nimport { x } from \'kay\'\n---\np hi\n', MOVES)).toEqual([])
  })
})
