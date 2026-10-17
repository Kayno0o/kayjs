// Runs `kay i18n translate` of kayjs-ai in a process of its own, as the content and message loaders serve one project per process; the fake model answers from the script given.
import type { Asked } from '../../packages/ai/src'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { AiError, fakeAi } from '../../packages/ai/src'
import translate from '../../packages/ai/src/translate'

type Edit = string | { replace: [string, string][] }

// A scripted model reply: every text translated as `FR <text>` unless `over` changes it (`$TEXT` standing for the source), a key added by `extra`, or the reply is the `text` given, or the ask fails.
interface Reply {
  text?: string
  over?: Record<string, Edit>
  extra?: Record<string, string>
  fail?: string
  writeBefore?: { path: string, text: string }
}

const [root, raw] = process.argv.slice(2) as [string, string]
const { args, flags, replies, i18n } = JSON.parse(raw) as { args: string[], flags: Record<string, boolean>, replies: Reply[], i18n: unknown }

function edited(text: string, edit: Edit | undefined): string {
  if (edit === undefined)
    return `FR ${text}`

  if (typeof edit === 'string')
    return edit.replaceAll('$TEXT', text)

  return edit.replace.reduce((value, [from, to]) => value.replace(from, to), `FR ${text}`)
}

for (const reply of replies) {
  if (reply.fail !== undefined) {
    fakeAi.fail(new AiError('network', reply.fail))

    continue
  }

  fakeAi.reply((asked: Asked) => {
    if (reply.writeBefore) {
      mkdirSync(dirname(`${root}/${reply.writeBefore.path}`), { recursive: true })
      writeFileSync(`${root}/${reply.writeBefore.path}`, reply.writeBefore.text)
    }

    if (reply.text !== undefined)
      return reply.text

    const texts = JSON.parse(asked.messages.at(-1)!.content) as Record<string, string>

    return JSON.stringify({ ...Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, edited(text, reply.over?.[id])])), ...reply.extra })
  })
}

const out: string[] = []
const err: string[] = []

console.log = (...parts: unknown[]) => void out.push(parts.join(' '))
console.error = (...parts: unknown[]) => void err.push(parts.join(' '))

let refused = false
const code = await translate.run({ values: flags, positionals: args }, () => {
  refused = true

  return 1
}, { root, config: { i18n } as never })

process.stdout.write(JSON.stringify({ code, refused, out: out.join('\n'), err: err.join('\n'), asked: fakeAi.asked }))
