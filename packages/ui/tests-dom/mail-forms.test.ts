import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import MailForms from '../tests/fixture/src/components/mail-forms.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

describe('ContactForm and SubscribeForm', () => {
  test('onSent is heard when onSend throws', async () => {
    const heard: string[] = []
    const listener = (event: ErrorEvent) => event.preventDefault()

    window.addEventListener('error', listener)

    try {
      mounted = await mountComponent(MailForms, {
        onSend: () => {
          heard.push('send')

          throw new Error('first')
        },
        onError: () => undefined,
        old: { contact: { onSent: () => heard.push('sent') } },
      })
      click(mounted.root.querySelector('#sent'))
      await settle()
    }
    finally {
      window.removeEventListener('error', listener)
    }

    expect(heard).toEqual(['send', 'sent'])
  })

  test('onSent still hears the result, after onSend', async () => {
    const heard: string[] = []

    mounted = await mountComponent(MailForms, {
      onSend: (data: unknown) => heard.push(`send ${String(data)}`),
      onError: () => undefined,
      onSubscribed: (data: unknown) => heard.push(`subscribe ${String(data)}`),
      old: { contact: { onSent: (data: unknown) => heard.push(`sent ${String(data)}`) }, subscribe: { onSent: (data: unknown) => heard.push(`subscribed ${String(data)}`) } },
    })
    click(mounted.root.querySelector('#sent'))
    await settle()

    expect(heard).toEqual(['send ok', 'sent ok', 'subscribe ok', 'subscribed ok'])
  })

  test('onSend runs once on success and the sent block replaces the notice', async () => {
    const sent: unknown[] = []
    const failures: unknown[] = []

    mounted = await mountComponent(MailForms, { onSend: (data: unknown) => sent.push(data), onError: (failure: unknown) => failures.push(failure) })

    const { root } = mounted

    expect(sent).toEqual([])
    click(root.querySelector('#sent'))
    await settle()

    expect(sent).toEqual(['ok'])
    expect(failures).toEqual([])
    expect(root.querySelector('.kui-contact-form #custom-sent')).not.toBeNull()
    expect(root.querySelector('.kui-contact-form [role="status"], .kui-contact-form .kui-notice')).toBeNull()
    // SubscribeForm takes a field between the email and its notice.
    expect(root.querySelector('.kui-subscribe-form #extra')).not.toBeNull()
  })

  test('SubscribeForm reports the same, and its sent block replaces the notice', async () => {
    const sent: unknown[] = []
    const failures: unknown[] = []

    mounted = await mountComponent(MailForms, { onSend: () => undefined, onError: () => undefined, onSubscribed: (data: unknown) => sent.push(data), onSubscribeError: (failure: unknown) => failures.push(failure) })
    click(mounted.root.querySelector('#refused'))
    await settle()

    expect(failures).toHaveLength(1)

    click(mounted.root.querySelector('#sent'))
    await settle()

    expect(sent).toEqual(['ok'])
    expect(mounted.root.querySelector('.kui-subscribe-form #subscribed')).not.toBeNull()
  })

  test('onError runs with the failure of a refused post, and onSend is quiet', async () => {
    const sent: unknown[] = []
    const failures: { errors: Record<string, string> }[] = []

    mounted = await mountComponent(MailForms, { onSend: (data: unknown) => sent.push(data), onError: (failure: { errors: Record<string, string> }) => failures.push(failure) })
    click(mounted.root.querySelector('#refused'))
    await settle()

    expect(failures.map(failure => failure.errors)).toEqual([{ email: 'Invalid' }])
    expect(sent).toEqual([])
  })
})
