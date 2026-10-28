import type { Action, ActionError, FailuresOf, ResolvedProtection, ResultOf, Settles } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import type { EventReader, StreamStatus } from '../runtime/live'
import type { PageReading } from './page'
import type { SiteScope } from './site-scope'
import type { CallArguments, FormValue, Tested, TestSite } from './site-types'
import { encodeCall, minTimeOf, readActionResponse, SETTLED, STAMP_FIELD } from '../runtime/action'
import { durationSeconds } from '../runtime/duration'
import { PAGE_HEADER, WORK_HEADER, WORK_SCRIPT } from '../runtime/swap'
import { solveWork } from '../runtime/work'
import { signStamp, stampTime } from '../server/stamp'
import { proofOfWork, signWork } from '../server/work'
import { NativeFormData } from './natives'
import { ORIGIN } from './site-scope'

// The URL the form posting to `action` carries on a page, which the browser posts to.
export function formUrl(page: PageReading, action: Pick<Action<never, unknown>, 'url'>): URL | undefined {
  const target = page.find('form').map(form => form.attributes.action).find(url => url !== undefined && new URL(url, ORIGIN).pathname.endsWith(action.url))

  return target === undefined ? undefined : new URL(target, ORIGIN)
}

// The stamp the form posting to `url` rendered with.
export function renderedStamp(page: PageReading, url: URL): string | undefined {
  return page.find(`form[action^="${url.pathname}"] input[name="${STAMP_FIELD}"]`)[0]?.attributes.value
}

// The stamp `minTime` reads, as the browser sends the form it was rendered in: dated `openedFor` ago when given, else the page's own made no younger than the action asks, so a test about something else is not refused as too fast.
function postedStamp(action: Action<never, unknown> & { protection?: ResolvedProtection }, rendered: string | undefined, openedFor: Duration | 0 | undefined): string | undefined {
  if (openedFor !== undefined)
    return signStamp(action.url, Date.now() - (openedFor === 0 ? 0 : durationSeconds(openedFor, 'openedFor') * 1000))

  const after = action.protection && minTimeOf(action.protection)?.after

  if (after === undefined)
    return rendered

  const latest = Date.now() - after
  const at = stampTime(action.url, rendered)

  return at !== undefined && at <= latest ? rendered : signStamp(action.url, latest)
}

// The solution kay's script sends to an action with `proofOfWork`, to a challenge signed here, as a test posts without a page's script.
function workHeaders(action: Action<never, unknown>): Record<string, string> {
  const work = proofOfWork(action)

  return work ? { [WORK_HEADER]: solveWork(signWork(action.url, work.difficulty, work.maxAge))! } : {}
}

function isStream(value: unknown): value is EventReader<unknown> & Settles {
  return (value as Partial<Settles> | null | undefined)?.[SETTLED] !== undefined
}

async function streamedValues(stream: EventReader<unknown> & Settles, url: string): Promise<unknown[]> {
  const values: unknown[] = []

  stream.on(value => void values.push(value))

  const status = await new Promise<StreamStatus>(resolve => stream[SETTLED](resolve))

  if (status !== 'done')
    throw new Error(`kay: the stream ${url} answered ${status} after ${values.length} values`)

  return values
}

export function actionsOf({ send, shown, follow, answeredAt }: SiteScope): Pick<TestSite, 'call' | 'submit' | 'refusal'> {
  const call: TestSite['call'] = async (action, ...[input, init = {}]) => {
    const { headers, body } = encodeCall(input)

    const sent: Record<string, string> = { ...headers, origin: ORIGIN }

    if (init.from !== undefined)
      sent[PAGE_HEADER] = shown(init.from)

    const answer = await readActionResponse<unknown>(await send(action.url, { method: 'POST', headers: { ...sent, ...workHeaders(action), ...init.headers }, body }), action.url)

    return (isStream(answer) ? await streamedValues(answer, action.url) : answer) as Tested<ResultOf<typeof action>>
  }

  return {
    call,
    submit: async (action, fields, init = {}) => {
      const page = typeof init.from === 'object' ? init.from : undefined
      const from = typeof init.from === 'object' ? init.from.url : init.from ?? '/'
      const url = page && formUrl(page, action)
      const posted = url === undefined ? action.url : url.pathname + url.search
      const form = new NativeFormData()

      const rendered = page && url && renderedStamp(page, url)
      const stamp = init.stamp ?? postedStamp(action, rendered, init.openedFor)

      if (stamp !== undefined && !(STAMP_FIELD in fields))
        form.set(STAMP_FIELD, stamp)

      // Its `workChallenge` fields post their solution, as kay's script sends them. A `from` given as a path has no rendered page, so it is visited to read the challenge.
      const worked = page ?? (typeof init.from === 'string' ? await follow(await send(init.from, { headers: init.headers }), init.from, init.headers) : undefined)
      const workUrl = page ? url : worked && formUrl(worked, action)

      for (const field of workUrl === undefined ? [] : worked?.find(`form[action^="${workUrl.pathname}"] input[${WORK_SCRIPT}]`) ?? []) {
        const { name, [WORK_SCRIPT]: challenge } = field.attributes

        if (name !== undefined && challenge !== undefined && !(name in fields))
          form.set(name, solveWork(challenge) ?? '')
      }

      for (const [name, value] of Object.entries(fields as Record<string, FormValue | FormValue[] | undefined>)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined)
            form.append(name, item)
        }
      }

      const response = await send(posted, {
        method: 'POST',
        headers: { origin: ORIGIN, referer: new URL((page && answeredAt.get(page)) ?? shown(from), ORIGIN).href, ...workHeaders(action), ...init.headers },
        body: form,
      })
      const visit = await follow(response, from, init.headers)

      if (!response.headers.has('location'))
        answeredAt.set(visit, shown(posted))

      return visit
    },
    refusal: async (action, input, init) => {
      try {
        await call(action, ...[input, init] as CallArguments<typeof action>)
      }
      catch (error) {
        // `Target` only bounds the action, so its own `refused` types the data as unknown.
        if (action.refused(error))
          return error as ActionError<FailuresOf<typeof action>>

        throw error
      }

      throw new Error(`kay: the call to ${action.url} went through, where a refusal was expected`)
    },
  }
}
