import { settle } from 'kay/test'
import { until } from '../tests/until'

const requests = () => (globalThis.fetch as unknown as { mock?: { calls: unknown[] } }).mock?.calls.length ?? 0

function send(form: Element): void {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

// Submits the form and waits for the save it sent to end: a request made, and the form no longer busy.
export async function submitted(form: Element): Promise<void> {
  const before = requests()

  send(form)
  await until(() => requests() > before && form.getAttribute('aria-busy') !== 'true')
  await settle()
}

// Submits a form that must send nothing, a deliberate wait for nothing to happen: a request would be made within it.
export async function submittedQuietly(form: Element): Promise<void> {
  send(form)
  for (let wait = 0; wait < 30; wait++) {
    await Bun.sleep(10)
    await settle()
  }
}
