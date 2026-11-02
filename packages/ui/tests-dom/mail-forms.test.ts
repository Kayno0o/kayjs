import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import MailForms from '../tests/fixture/src/components/mail-forms.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

describe('ContactForm and SubscribeForm', () => {
  test('onSent runs once on success and the sent block replaces the notice', async () => {
    const sent: unknown[] = []
    const failures: unknown[] = []

    mounted = await mountComponent(MailForms, { onSent: (data: unknown) => sent.push(data), onError: (failure: unknown) => failures.push(failure) })

    const { root } = mounted

    expect(sent).toEqual([])
    click(root.querySelector('#sent'))
    await settle()

    expect(sent).toEqual(['ok'])
    expect(failures).toEqual([])
    expect(root.querySelector('.kui-contact-form #custom-sent')).not.toBeNull()
    expect(root.querySelector('.kui-contact-form [role="status"], .kui-contact-form .kui-notice')).toBeNull()
    // SubscribeForm keeps its notice, and takes a field between the email and its notice.
    expect(root.querySelector('.kui-subscribe-form .kui-notice')).not.toBeNull()
    expect(root.querySelector('.kui-subscribe-form #extra')).not.toBeNull()
  })

  test('onError runs with the failure of a refused post, and onSent is quiet', async () => {
    const sent: unknown[] = []
    const failures: { errors: Record<string, string> }[] = []

    mounted = await mountComponent(MailForms, { onSent: (data: unknown) => sent.push(data), onError: (failure: { errors: Record<string, string> }) => failures.push(failure) })
    click(mounted.root.querySelector('#refused'))
    await settle()

    expect(failures.map(failure => failure.errors)).toEqual([{ email: 'Invalid' }])
    expect(sent).toEqual([])
  })
})
