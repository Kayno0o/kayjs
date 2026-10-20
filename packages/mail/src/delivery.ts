import type { Relay } from './preview'
import type { Mail } from './types'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { KAY_DIR, underKayDev } from 'kay/library'

// One address, as the send form takes: a comma or a name would add a recipient.
export const ONE_ADDRESS = /^[^\s<>@,]+@[^\s<>@,]+$/

// Where `kay dev` keeps the "Send for real" switch for this checkout, beside what it generates and out of git, so the server restarting keeps it.
const SWITCH_FILE = 'mail-delivery.json'

const switchPath = (): string => join(process.cwd(), KAY_DIR, SWITCH_FILE)

// The server `kay dev` runs, which alone reads the switch: one started with NODE_ENV=development outside it, or under test or in production, never does.
export function switchRead(): boolean {
  return process.env.NODE_ENV === 'development' && underKayDev()
}

// The address every mail is delivered to while the switch is on, none when it is off, missing or edited into something that is no address.
export async function deliveryAddress(): Promise<string | undefined> {
  if (!switchRead())
    return undefined

  try {
    const { to } = await Bun.file(switchPath()).json() as { to?: unknown }

    return typeof to === 'string' && ONE_ADDRESS.test(to) ? to : undefined
  }
  catch {
    return undefined
  }
}

// Turns the switch on for `to`, or off without one.
export async function setDeliveryAddress(to: string | undefined): Promise<void> {
  if (to === undefined)
    await rm(switchPath(), { force: true })
  else
    await Bun.write(switchPath(), `${JSON.stringify({ to })}\n`)
}

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

// Sends it over the relay to the address alone, answering what went wrong, or nothing once the server took it.
export async function attempt(relay: Relay, mail: Mail, to: string): Promise<string | undefined> {
  try {
    const { rejected, response } = await relay.send(mail, to)

    return rejected.length > 0 ? `the server refused ${rejected.join(', ')}${response === undefined || response === '' ? '' : `: ${response}`}` : undefined
  }
  catch (error) {
    return messageOf(error)
  }
}
