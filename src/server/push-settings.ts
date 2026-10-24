import { underKayDev } from '../build/assets'
import { kayLog } from '../runtime/log'
import { pushStore } from './push-store'

export const PUSH_PATH = '/_kay/push'
export const PUSH_KEY_PATH = `${PUSH_PATH}/key`
export const PUSH_SUBSCRIBE_PATH = `${PUSH_PATH}/subscribe`
export const PUSH_UNSUBSCRIBE_PATH = `${PUSH_PATH}/unsubscribe`

export interface PushSettings {
  // The VAPID contact, a `mailto:` or https address the push services reach the site's operator by.
  subject: string | undefined
}

let current: PushSettings | undefined

// Set by `push()` in kay.config.ts; undefined while the app lists none.
export function pushSettings(): PushSettings | undefined {
  return current
}

export function setPushSettings(settings: PushSettings | undefined): void {
  current = settings
}

let looseForTest = false

// For a test: plays the push service on loopback and generates VAPID keys as `kay dev` does.
export function setPushLoose(loose: boolean): void {
  looseForTest = loose
}

// Whether the server relaxes what production demands: loopback and private push endpoints, and VAPID keys generated into `.kay`. Only under `kay dev` (and tests); a deploy with any `NODE_ENV` is treated as production.
export function pushLoose(): boolean {
  return underKayDev() || looseForTest
}

const pending = new Set<Promise<void>>()

// Pushes what `notify()` stored to the person's devices without making `notify` wait for the push services, and never fails it.
export function pushAlongside(user: string, message: { title: string, url?: string | undefined }): void {
  if (current === undefined)
    return

  const run = async (): Promise<void> => {
    try {
      const { sendPush } = await import('./push')

      if ((await pushStore().list(user)).length > 0)
        await sendPush(user, message)
    }
    catch (error) {
      kayLog('warn', `notify() could not push a notification to ${user}`, error)
    }
  }
  const job = run()

  pending.add(job)
  void job.finally(() => pending.delete(job))
}

// Resolves once every push `notify()` started has been answered, for a test reading what a push service got.
export async function pushesSettled(): Promise<void> {
  await Promise.all(pending)
}
