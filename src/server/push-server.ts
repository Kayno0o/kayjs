import type { AnyElysia, Elysia } from 'elysia'
import { isCrossSite } from './actions'
import { readCapped } from './errors'
import { clientAddress, overLimit } from './protection'
import { clearPushDeviceCookie, MOST_DEVICES, pushDeviceCookie, readSubscription, vapidKeys } from './push'
import { PUSH_KEY_PATH, PUSH_SUBSCRIBE_PATH, PUSH_UNSUBSCRIBE_PATH } from './push-settings'
import { pushStore } from './push-store'
import { overHttps } from './request-url'
import { userOf } from './request-user'

const MAX_BODY_BYTES = 2048
const CHANGES_PER_MINUTE = 60
const MINUTE_MS = 60_000
const RATE_NAME = 'kay:push'

const none = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

// Parses a request body that is a JSON object, or answers the refusal.
async function bodyOf(request: Request, server: Parameters<typeof clientAddress>[1]): Promise<Response | unknown> {
  if (isCrossSite(request))
    return none(403)

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES)
    return none(413)

  if (await overLimit(RATE_NAME, clientAddress(request, server), CHANGES_PER_MINUTE, MINUTE_MS) !== undefined)
    return none(429)

  const text = await readCapped(request, MAX_BODY_BYTES)

  if (text === undefined)
    return none(413)

  try {
    return JSON.parse(text)
  }
  catch {
    return none(400)
  }
}

// The routes the island's `push` calls: the public key to subscribe with, and the person's subscribing and unsubscribing, whose user comes from whatever names the request's user, kayjs-auth say, never from the body.
export async function pushServer(): Promise<AnyElysia> {
  // Read at boot, so a production server without a valid pair stops rather than failing the first push.
  const { publicKey } = await vapidKeys()
  const plugin = (app: Elysia) => app
    .get(PUSH_KEY_PATH, () => new Response(publicKey, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } }))
    .post(PUSH_SUBSCRIBE_PATH, async ({ request, server }) => {
      const body = await bodyOf(request, server)

      if (body instanceof Response)
        return body

      const user = await userOf(request)

      if (user === undefined)
        return none(401)

      const subscription = await readSubscription(body)

      if (subscription === undefined)
        return none(400)

      await pushStore().add(user, subscription, MOST_DEVICES)

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': pushDeviceCookie(subscription.endpoint, overHttps(request)) } })
    }, { parse: 'none' })
    .post(PUSH_UNSUBSCRIBE_PATH, async ({ request, server }) => {
      const body = await bodyOf(request, server)

      if (body instanceof Response)
        return body

      const user = await userOf(request)

      if (user === undefined)
        return none(401)

      const endpoint = typeof body === 'object' && body !== null ? (body as { endpoint?: unknown }).endpoint : undefined

      if (typeof endpoint !== 'string')
        return none(400)

      await pushStore().remove(endpoint, user)

      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': clearPushDeviceCookie(overHttps(request)) } })
    }, { parse: 'none' })

  return plugin as unknown as AnyElysia
}
