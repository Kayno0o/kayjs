import { join } from 'node:path'
import { Glob } from 'bun'
import { describe, expect, test } from 'bun:test'

// The rules of `llms/component-library-conventions.md#callbacks`: a transition callback takes one event object, and one naming rule names it. Each rule is an entry of `RULES` or `CONTRACTS`, so a rule for another family of callbacks (the server libraries' hooks) is one more entry.
const ROOT = join(import.meta.dir, '..')

interface Callback {
  file: string
  name: string
  // The parameter list as written, or undefined for a type taken from elsewhere (`ChatProps['onSend']`).
  parameters: string[] | undefined
  // The keys of the one event object, when the parameter is an inline `{ ... }` type.
  fields: string[] | undefined
  // Every prop and member declared in the same file, to find the prop a callback reports.
  siblings: Set<string>
  deprecated: boolean
}

// Where callbacks of components are declared: the props of every `.kay` component, and the helpers of kayjs-ui and kayjs-ai's chat that type them.
const SOURCES = ['packages/*/src/**/*.kay', 'packages/ui/src/**/*.ts', 'packages/ai/src/chat-session.ts']

const DECLARATION = /^ {2}(?:readonly )?(on[A-Z]\w*)\??: (.+)$/

// Splits at the commas outside any bracket.
function split(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if ('([{<'.includes(char)) {
      depth++
    }
    else if (')]}'.includes(char) || (char === '>' && text[index - 1] !== '=')) {
      depth--
    }
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(from, index).trim())
      from = index + 1
    }
  }

  const last = text.slice(from).trim()

  return last === '' ? parts : [...parts, last]
}

// The parameters of the function type a declaration writes, `((event: { a: A }) => unknown) | undefined` giving `event: { a: A }`.
function parametersOf(type: string): string[] | undefined {
  // The parenthesis that opens the parameters is the last of the leading run, the ones before it wrap the function type.
  const open = (/^[(\s]*/).exec(type)![0].lastIndexOf('(')

  if (open < 0)
    return undefined

  let depth = 0

  for (let index = open; index < type.length; index++) {
    if (type[index] === '(')
      depth++
    else if (type[index] === ')' && --depth === 0)
      return type.slice(open + 1, index).trim() === '' ? [] : split(type.slice(open + 1, index))
  }

  return undefined
}

function fieldsOf(parameter: string): string[] | undefined {
  const object = (/^\w+\??: \{(.*)\}$/s).exec(parameter)

  return object ? split(object[1]!).map(field => (/^(?:readonly )?(\w+)/).exec(field)![1]!) : undefined
}

async function declared(): Promise<Callback[]> {
  const found: Callback[] = []

  for (const pattern of SOURCES) {
    for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
      if (file.includes('node_modules') || file.includes('/tests/'))
        continue

      const lines = (await Bun.file(join(ROOT, file)).text()).split('\n')
      const siblings = new Set(lines.flatMap(line => (/^ {2}(?:readonly )?(\w+)\??:/).exec(line)?.[1] ?? []))

      for (const [index, line] of lines.entries()) {
        const match = DECLARATION.exec(line)

        if (!match)
          continue

        const parameters = parametersOf(match[2]!)

        found.push({
          file,
          name: match[1]!,
          parameters,
          fields: parameters?.length === 1 ? fieldsOf(parameters[0]!) : undefined,
          siblings,
          deprecated: lines.slice(Math.max(0, index - 3), index).some(above => above.includes('@deprecated')),
        })
      }
    }
  }

  return found.filter(callback => !callback.deprecated)
}

const callbacks = await declared()

// Callbacks that hear what the platform fires, so their one parameter is the DOM event itself.
const NATIVE = /^(?:\w+: )?(?:[A-Z]\w*)?Event$/

// A transition callback takes one event object, however many things it reports: `({ open })`, `({ value, option })`.
const RULES: { name: string, check: (callback: Callback) => string | undefined }[] = [
  {
    name: 'takes at most one parameter',
    check: ({ parameters }) => parameters !== undefined && parameters.length > 1 ? `takes ${parameters.length} positional arguments, one event object holds them as fields` : undefined,
  },
  {
    name: 'takes an event object, not a bare value',
    check: ({ parameters, fields }) => {
      const [parameter] = parameters ?? []

      if (parameter === undefined || fields !== undefined || NATIVE.test(parameter))
        return undefined

      // A named type is an object a helper builds (`BoardMove`, `RecordFailure`), and a bare primitive, array or file is a value.
      return (/^\w+\??: (?:string|number|boolean|null|undefined|unknown|readonly |[a-z]\w*\[\]|File\b|Date\b|[A-Z]\w*\[\])/).test(parameter) || (/\[\]$/).test(parameter) ? `takes \`${parameter}\`, which is a bare value: wrap it as \`{ <name>: ... }\`` : undefined
    },
  },
  {
    name: 'names its event fields in camelCase',
    check: ({ fields }) => fields?.find(field => !(/^[a-z][A-Za-z0-9]*$/).test(field)) === undefined ? undefined : 'has a field that is not camelCase',
  },
]

// One name per meaning: each name on the left is the one on the right.
const SYNONYMS: Record<string, string> = {
  onToggle: 'onOpenChange',
  onClose: 'onOpenChange',
  onOpen: 'onOpenChange',
  onPick: 'onSelect',
  onChoose: 'onSelect',
  onSelected: 'onSelectedChange',
  onChanged: 'onChange',
  onUpdate: 'onChange',
  onValueChanged: 'onValueChange',
}

// Change callbacks that only observe state the component owns, with no prop to hold it, or that hold it as a list (`expanded`) of the things they report one at a time.
const OBSERVE_ONLY = new Set(['record.ts:onRecordingChange', 'table-expand.ts:onOpenChange', 'audio-player.kay:onChapterChange', 'date-input.kay:onMonthChange', 'date-range-input.kay:onMonthChange', 'hover-card.kay:onOpenChange', 'table.kay:onOpenChange', 'table.kay:onScrollChange', 'tree-view.kay:onOpenChange'])
// `on<Prop>Change` whose event names what it reports beside or in place of the prop's own name: a table holds `selected` as keys and reports `{ keys, rows }`, a chart holds `active` and reports its `index`.
const ALIASED = new Set(['accordion.kay:onValueChange', 'tabs.kay:onValueChange', 'theme-toggle.kay:onValueChange', 'zoom-pane.kay:onPlateChange', 'timeline.kay:onSelectedChange', 'tree-view.kay:onSelectedChange', 'table.kay:onSelectedChange', 'table.kay:onHiddenColumnsChange', 'split-layout.kay:onDetailOpenChange', 'split-layout.kay:onSidebarOpenChange', 'markdown-editor.kay:onPreviewChange', 'audio-player.kay:onPositionChange', ...['bar-chart', 'line-chart', 'scatter-chart', 'sparkline', 'contribution-graph'].map(chart => `${chart}.kay:onActiveChange`)])

const base = (file: string) => file.slice(file.lastIndexOf('/') + 1)
const key = (callback: Callback) => `${base(callback.file)}:${callback.name}`

describe('a callback takes one event object', () => {
  for (const rule of RULES) {
    test(rule.name, () => {
      expect(callbacks.flatMap((callback) => {
        const problem = rule.check(callback)

        return problem === undefined ? [] : [`${callback.file}: ${callback.name} ${problem}`]
      })).toEqual([])
    })
  }
})

describe('one naming rule', () => {
  test('on<Prop>Change sits beside the prop it reports, and the prop beside it follows it', () => {
    const broken = callbacks.flatMap((callback) => {
      const prop = (/^on([A-Z]\w*)Change$/).exec(callback.name)?.[1]

      if (prop === undefined || ALIASED.has(key(callback)) || OBSERVE_ONLY.has(key(callback)))
        return []

      const lower = prop[0]!.toLowerCase() + prop.slice(1)

      return callback.siblings.has(lower) || callback.siblings.has(prop) ? [] : [`${callback.file}: ${callback.name} has no \`${lower}\` prop`]
    })

    expect(broken).toEqual([])
  })

  test('on<Prop>Change reports the prop it follows as the field of its event', () => {
    const broken = callbacks.flatMap((callback) => {
      const prop = (/^on([A-Z]\w*)Change$/).exec(callback.name)?.[1]
      const lower = prop === undefined ? undefined : prop[0]!.toLowerCase() + prop.slice(1)

      if (lower === undefined || callback.fields === undefined || ALIASED.has(key(callback)) || OBSERVE_ONLY.has(key(callback)) || !callback.siblings.has(lower))
        return []

      return callback.fields.includes(lower) ? [] : [`${callback.file}: ${callback.name} reports ${callback.fields.join(', ')}, not \`${lower}\``]
    })

    expect(broken).toEqual([])
  })

  test('onSelect is the press of an item: a component with a selected prop reports through onSelectedChange', () => {
    expect(callbacks.filter(callback => callback.name === 'onSelect' && callback.siblings.has('selected')).map(callback => `${callback.file}: onSelect beside \`selected\` is onSelectedChange`)).toEqual([])
  })

  test('onSelectedChange only reports a selected prop', () => {
    expect(callbacks.filter(callback => callback.name === 'onSelectedChange' && !callback.siblings.has('selected')).map(callback => `${callback.file}: onSelectedChange has no \`selected\` prop`)).toEqual([])
  })

  test('a meaning has one name', () => {
    expect(callbacks.filter(callback => callback.name in SYNONYMS).map(callback => `${callback.file}: ${callback.name} is ${SYNONYMS[callback.name]}`)).toEqual([])
  })

  test('a callback is not declared twice with different events in one file', () => {
    const seen = new Map<string, string>()
    const broken: string[] = []

    for (const callback of callbacks) {
      const events = callback.fields?.join(',') ?? ''
      const previous = seen.get(key(callback))

      // A menu's check item reports `{ checked }` and its radio item `{ checked, value }`: one the superset of the other.
      if (previous !== undefined && previous !== events && events !== '' && previous !== '' && !events.startsWith(previous) && !previous.startsWith(events))
        broken.push(`${callback.file}: ${callback.name} reports ${previous} and ${events}`)

      seen.set(key(callback), events)
    }

    expect(broken).toEqual([])
  })
})

// What the docs write for a callback must be what the code declares: `onOpenChange({ open })`, never a bare `onOpenChange(false)`.
describe('the docs write the signatures the code has', () => {
  const FIELDS = new Map<string, Set<string>>()

  for (const callback of callbacks) {
    for (const field of callback.fields ?? [])
      FIELDS.set(callback.name, (FIELDS.get(callback.name) ?? new Set()).add(field))
  }

  const SERVER_HOOKS = new Set(['onError', 'onSend', 'onSave'])
  // Positional by design: the `ai({ ... })` hooks (`Hook<AiToolCall>`) and the cms `CustomFieldProps.onChange(next)` setter, not component events.
  const POSITIONAL = new Set(['packages/cms/llms/fields.md:onChange'])
  const SIGNATURE = /`(on[A-Z]\w*)\(([^`]*)\)`/g
  const DOCS = ['docs/src/content/ui/*.md', 'docs/src/content/docs/**/*.md', 'llms/*.md', 'packages/*/llms/*.md', 'packages/*/llms.txt', 'llms.txt']

  test('a callback written with arguments writes its event object, with the fields the code declares', async () => {
    const broken: string[] = []

    for (const pattern of DOCS) {
      for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
        if (file.includes('node_modules') || file.endsWith('upgrading.md') || file.endsWith('upgrading-archive.md') || file.includes('whats-new'))
          continue

        const text = await Bun.file(join(ROOT, file)).text()

        for (const [, name, args] of text.matchAll(SIGNATURE)) {
          const known = FIELDS.get(name!)

          // Only the callbacks of components: a server hook of the same name (`onError`) is another rule's.
          if (known === undefined || args!.trim() === '' || args!.trim() === '...')
            continue

          // `onError`, `onSend` and `onSave` are also the server hooks of mail, cms and queues, whose events carry other fields.
          if (SERVER_HOOKS.has(name!) && args!.trim().startsWith('{'))
            continue

          if (!args!.trim().startsWith('{') && POSITIONAL.has(`${file}:${name}`))
            continue

          if (!args!.trim().startsWith('{')) {
            broken.push(`${file}: \`${name}(${args})\` takes one event object, \`${name}({ ${[...known].join(', ')} })\``)

            continue
          }

          for (const field of split(args!.trim().slice(1, args!.trim().lastIndexOf('}'))).map(one => (/^(\w+)/).exec(one)?.[1])) {
            if (field !== undefined && !known.has(field))
              broken.push(`${file}: \`${name}({ ${field} })\` has no \`${field}\` field, the code has ${[...known].join(', ')}`)
          }
        }
      }
    }

    expect(broken).toEqual([])
  })
})

// The server libraries' hooks, read from their API snapshots: one observing a step is `after<Verb>` and one that may veto or change it `before<Verb>`, so an `on<Name>` member left on an exported type is deprecated or one of these.
const SERVER_ON = new Map([
  ['onError', 'the error channel every library shares'],
  ['onEvent', 'auth\'s stream of events, not a step'],
  ['onRestart', 'a reader of streamed deltas told the text starts over, not a hook'],
  ['onAccent', 'a palette colour'],
  ['onDanger', 'a palette colour'],
])

describe('server hooks', () => {
  test('observe as after<Verb>, with only the listed on<Name> members left', async () => {
    const found: string[] = []

    for (const library of ['auth', 'mail', 'cms', 'ai']) {
      // The export each member line belongs to: a component's props follow the component rule.
      let owner = ''

      for (const line of (await Bun.file(join(ROOT, `api/${library}.txt`)).text()).split('\n')) {
        if (!line.startsWith(' ')) {
          owner = line

          continue
        }

        const name = (/^\s+(?:readonly )?(on[A-Z]\w*)\??:/).exec(line)?.[1]

        if (name !== undefined && !SERVER_ON.has(name) && !owner.includes('.kay]') && !owner.startsWith('component') && !owner.startsWith('}') && !(/Props\b/).test(owner))
          found.push(`${library}: ${name} in ${owner.slice(0, 80)}`)
      }
    }

    expect(found).toEqual([])
  })
})
