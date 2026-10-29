import type { ObjectProperty } from 'oxc-parser'
import type { Node } from '../compiler/estree'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProgram, positionOf } from '../compiler/estree'
import { constBindings, exportedDefault, keyName, objectOf, unwrapped } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'

export interface ConfigPosition {
  line: number
  column: number
}

const START: ConfigPosition = { line: 1, column: 1 }

function positionIn(source: string, node: Node): ConfigPosition {
  const { line, column } = positionOf(source, node.start)

  return { line, column: column + 1 }
}

export function readConfigSource(root: string): string | undefined {
  try {
    return readFileSync(join(root, CONFIG_FILE), 'utf8')
  }
  catch {
    return undefined
  }
}

// Where a key sits in kay.config.ts's source: the key itself when it is set, whatever its value, else the deepest key above it that is, else the `defineConfig` call or the default export. A source that cannot be read or has no such export puts everything at line 1.
export function configLocator(source: string | undefined): (path: string[]) => ConfigPosition {
  if (source === undefined)
    return () => START

  const { program } = parseProgram(source, { recover: true })
  const bindings = constBindings(program, true)
  const exported = exportedDefault(program)
  const root = exported && unwrapped(exported)

  if (!root)
    return () => START

  const anchor = positionIn(source, root)
  const config = root.type === 'CallExpression' ? objectOf(root.arguments[0], bindings) : objectOf(root, bindings)

  return (path) => {
    let found = anchor
    let object = config

    for (const key of path) {
      const property = object?.properties.find((candidate): candidate is ObjectProperty => candidate.type === 'Property' && !candidate.method && candidate.kind === 'init' && keyName(candidate) === key)

      if (!property)
        break

      found = positionIn(source, property.key)
      object = objectOf(property.value, bindings)
    }

    return found
  }
}
