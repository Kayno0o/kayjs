import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { join } from 'node:path'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, objectOf, propertiesOf } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'
import { readConfigSource } from './config-keys'

type Property = NodeOfType<'Property'>

function named(properties: readonly Node[], name: string): Property | undefined {
  return properties.find((property): property is Property => property.type === 'Property' && keyName(property) === name)
}

// `permanent` of a redirect in kay.config.ts, `status` since 1.96: one spelling for 301, 302, 307, 308 and now 410, where `permanent` named two of them and could contradict `status`.
// `permanent: false` becomes `status: 307` and `permanent: true`, a 308 already, is dropped, as it is beside a `status` that agrees; any other form is reported with no fix.
export function redirectPermanent(root: string, options: CheckOptions): CheckDiagnostic[] {
  if (lintLevel('deprecated-redirect-permanent', options.lints) === 'allow')
    return []

  const source = readConfigSource(root)

  if (source === undefined || !source.includes('permanent'))
    return []

  const { program } = parseProgram(source, { recover: true })
  const bindings = constBindings(program, true)
  const config = exportedObject(program, bindings)
  const redirects = objectOf(named(config ? propertiesOf(config, bindings) : [], 'redirects')?.value, bindings)
  const levelAt = lintLevels(source, options.lints)
  const found: CheckDiagnostic[] = []

  for (const entry of redirects ? propertiesOf(redirects, bindings) : []) {
    const object = entry.type === 'Property' ? objectOf(entry.value, bindings) : undefined
    const properties = object ? propertiesOf(object, bindings) : []
    const permanent = named(properties, 'permanent')

    if (!object || !permanent || levelAt('deprecated-redirect-permanent', permanent.start) === 'allow')
      continue

    const status = named(properties, 'status')
    const value = permanent.value.type === 'Literal' && typeof permanent.value.value === 'boolean' ? permanent.value.value : undefined
    // Written in the entry itself, not spread in from a const, which another entry may share.
    const written: readonly Node[] = object.properties
    const at = written.indexOf(permanent)
    const own = at !== -1
    const named301Or308 = status?.value.type === 'Literal' && (status.value.value === 301 || status.value.value === 308)
    const agrees = status !== undefined && named301Or308 === value
    let edits: { start: number, end: number, text: string }[] | undefined

    if (own && value === false && status === undefined) {
      edits = [{ start: permanent.start, end: permanent.end, text: 'status: 307' }]
    }
    // A `permanent: true` is the default answer, a 308, as a `status` that agrees with it is.
    else if (own && (agrees || (value === true && status === undefined))) {
      const next = written[at + 1]
      const before = written[at - 1]

      if (next)
        edits = [{ start: permanent.start, end: next.start, text: '' }]
      else if (before)
        edits = [{ start: before.end, end: permanent.end, text: '' }]
    }

    const help = edits?.[0]?.text === '' ? 'drop `permanent`, the redirect answers 308 or its `status` without it' : 'write `status: 307` for `permanent: false`, and drop `permanent: true`, which is the default'

    found.push({
      file: join(root, CONFIG_FILE),
      ...positionAt(source, permanent.start),
      end: permanent.end,
      message: '`permanent` of a redirect is deprecated since 1.96: `status` names every answer, 301, 302, 307, 308 and 410, and cannot contradict a second option',
      help,
      code: 'deprecated-redirect-permanent',
      severity: levelAt('deprecated-redirect-permanent', permanent.start) === 'warn' ? 'warning' : 'error',
      ...edits && { fixes: [{ title: help[0]!.toUpperCase() + help.slice(1), edits, safe: true }] },
    })
  }

  return found
}
