import type { TSchema } from 'kay/library'
import type { Reply, StructuredReply } from './types'
import { checkAnswer } from 'kay/library'
import { AiError } from './errors'
import { parsePartial } from './partial-json'

const MAX_MESSAGE = 500

function refusedWith(text: string, reason: string, fields: string[] = []): AiError {
  return new AiError('schema', reason.slice(0, MAX_MESSAGE), { partial: text, fields })
}

// The object an answer's text is, checked against the schema: the value as the schema types it, else an error of the `schema` kind that says why.
function valueOf(schema: TSchema, text: string, finish: string | undefined): unknown {
  let value: unknown

  try {
    value = JSON.parse(text)
  }
  catch {
    if (finish === 'length')
      throw refusedWith(text, 'the answer was cut by maxTokens before the JSON object was whole')

    if (finish === 'filtered')
      throw refusedWith(text, 'the provider refused to answer')

    if (finish === 'steps')
      throw refusedWith(text, 'the model was still calling tools after the last of maxSteps requests, so it gave no answer')

    throw refusedWith(text, text.trim() === '' ? 'the model gave no answer' : 'the answer is not a JSON object alone, with no text around it')
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw refusedWith(text, 'the answer is JSON but not an object')

  const checked = checkAnswer(schema, value)

  if ('value' in checked)
    return checked.value

  throw refusedWith(text, `the answer does not fit the schema: ${checked.issues.map(({ path, message }) => `${path === '' ? 'the answer' : path} (${message})`).join(', ')}`, checked.issues.filter(({ path }) => path !== '').map(({ path }) => path))
}

// A reply read as the object it answers: `await` checks the whole text once it ended, `for await` gives the object so far, and the last value it gives is the checked one.
export function structured<Value>(base: Reply, schema: TSchema): StructuredReply<Value, unknown> {
  let answered: Promise<Value> | undefined

  const answer = async (): Promise<Value> => {
    const text = await base

    return valueOf(schema, text, await base.finish) as Value
  }

  const once = async (): Promise<Value> => answered ??= answer()

  return {
    // eslint-disable-next-line kaynooo/no-then -- the thenable's own `then`, passed through
    then: async (onFulfilled, onRejected) => once().then(onFulfilled, onRejected),
    [Symbol.asyncIterator]: () => {
      const source = base[Symbol.asyncIterator]()
      let last: string | undefined
      let closed = false

      return {
        async next() {
          while (!closed) {
            const step = await source.next()

            if (step.done === true) {
              closed = true

              const value = await once()
              const encoded = JSON.stringify(value)

              if (encoded === last)
                break

              return { done: false, value }
            }

            const part = parsePartial(step.value)
            const encoded = part === undefined ? undefined : JSON.stringify(part)

            if (part === undefined || encoded === last)
              continue

            last = encoded

            return { done: false, value: part }
          }

          return { done: true, value: undefined }
        },
        async return() {
          closed = true
          await source.return?.()

          return { done: true, value: undefined }
        },
      }
    },
    deltas: base.deltas,
    get usage() {
      return base.usage
    },
    get finish() {
      return base.finish
    },
    get calls() {
      return base.calls
    },
    stop: base.stop,
  }
}
