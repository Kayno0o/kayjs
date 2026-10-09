import process from 'node:process'
import { styleText } from 'node:util'

// What the terminal sends for a key: an arrow's escape sequence, or one character, a lone Escape included.
// eslint-disable-next-line no-control-regex -- escape sequences are what it splits
const KEY_SEQUENCES = /\x1B[[O][A-D]|[\s\S]/g

type Key = 'up' | 'down' | 'toggle' | 'enter' | 'cancel'

const KEYS: Record<string, Key> = { '\x1B[A': 'up', '\x1BOA': 'up', 'k': 'up', '\x1B[B': 'down', '\x1BOB': 'down', 'j': 'down', ' ': 'toggle', '\r': 'enter', '\n': 'enter', '\x03': 'cancel', '\x1B': 'cancel' }

interface Choice<T> {
  value: T
  label: string
  hint: string
}

// The keys a chunk of terminal input holds, in order, the ones no prompt reads left out.
function readKeys(input: string): Key[] {
  return (input.match(KEY_SEQUENCES) ?? []).flatMap(sequence => KEYS[sequence] ?? [])
}

// One choice among several, the arrow keys moving and Enter picking it; undefined once Escape or Ctrl+C cancels.
export async function select<T>(question: string, choices: Choice<T>[], initial: number): Promise<T | undefined> {
  let cursor = initial
  const accepted = await ask(
    state => state === 'asking' ? [`${mark()} ${question} ${dim('(arrows move, enter picks)')}`, ...rows(choices, cursor, () => '')] : [answer(question, state, choices[cursor]!.label)],
    (key) => {
      if (key === 'up' || key === 'down')
        cursor = move(cursor, key, choices.length)

      return key === 'enter' || key === 'cancel' ? key : undefined
    },
  )

  return accepted ? choices[cursor]!.value : undefined
}

// Several choices, Space checking or unchecking the one under the cursor through `toggle`, which may change others along, and Enter accepting what is checked.
export async function checklist<T>(question: string, choices: Choice<T>[], initial: ReadonlySet<T>, toggle: (checked: ReadonlySet<T>, value: T) => ReadonlySet<T>): Promise<ReadonlySet<T> | undefined> {
  let cursor = 0
  let checked = initial
  const accepted = await ask(
    state => state === 'asking' ? [`${mark()} ${question} ${dim('(arrows move, space toggles, enter accepts)')}`, ...rows(choices, cursor, choice => checked.has(choice.value) ? '[x] ' : '[ ] ')] : [answer(question, state, choices.filter(choice => checked.has(choice.value)).map(choice => choice.label).join(', ') || 'none')],
    (key) => {
      if (key === 'up' || key === 'down')
        cursor = move(cursor, key, choices.length)

      if (key === 'toggle')
        checked = toggle(checked, choices[cursor]!.value)

      return key === 'enter' || key === 'cancel' ? key : undefined
    },
  )

  return accepted ? checked : undefined
}

function move(cursor: number, key: 'up' | 'down', length: number): number {
  return (cursor + (key === 'up' ? length - 1 : 1)) % length
}

function mark(): string {
  return styleText('cyan', '?', { stream: process.stderr })
}

// The line a prompt leaves once answered: what was picked, or that it was cancelled.
function answer(question: string, state: 'enter' | 'cancel', picked: string): string {
  return `${mark()} ${question} ${state === 'enter' ? styleText('cyan', picked, { stream: process.stderr }) : dim('cancelled')}`
}

function dim(text: string): string {
  return styleText('dim', text, { stream: process.stderr })
}

// A line per choice, cut to the terminal's width so none wraps, which would throw off the redraw.
function rows<T>(choices: Choice<T>[], cursor: number, marker: (choice: Choice<T>) => string): string[] {
  const width = Math.max(...choices.map(choice => choice.label.length))
  const columns = process.stderr.columns ?? 80

  return choices.map((choice, index) => {
    const head = `${index === cursor ? '>' : ' '} ${marker(choice)}${choice.label.padEnd(width)}  `
    const room = columns - head.length - 1
    const hint = choice.hint.length > room ? `${choice.hint.slice(0, Math.max(room - 3, 0))}...` : choice.hint

    return `${index === cursor ? styleText('cyan', head, { stream: process.stderr }) : head}${dim(hint)}`
  })
}

// Draws a prompt on stderr and redraws it after each key stdin sends raw, until `press` answers `enter` or `cancel`; true once entered.
async function ask(render: (state: 'asking' | 'enter' | 'cancel') => string[], press: (key: Key) => 'enter' | 'cancel' | undefined): Promise<boolean> {
  const { stdin, stderr } = process
  let drawn = 0
  let outcome: 'enter' | 'cancel' | undefined
  const draw = (state: 'asking' | 'enter' | 'cancel') => {
    const frame = render(state)

    stderr.write(`${drawn > 1 ? `\x1B[${drawn - 1}A` : ''}\r\x1B[0J${frame.join('\n')}`)
    drawn = frame.length
  }

  stdin.setRawMode(true)
  stdin.resume()
  stderr.write('\x1B[?25l')
  draw('asking')

  try {
    return await new Promise<boolean>((resolve) => {
      const onData = (data: Buffer) => {
        for (const key of readKeys(data.toString())) {
          outcome = press(key)

          if (outcome !== undefined) {
            stdin.off('data', onData)
            resolve(outcome === 'enter')

            return
          }
        }

        draw('asking')
      }

      stdin.on('data', onData)
    })
  }
  finally {
    draw(outcome ?? 'cancel')
    stderr.write('\n\x1B[?25h')
    stdin.setRawMode(false)
    stdin.pause()
  }
}
