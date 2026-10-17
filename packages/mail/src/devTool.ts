import type { DevTool } from 'kay/dev-tool'

// The dev tool's Mail tab, a browser module kay loads on dev pages: the mails sent to the outbox, each previewed in place or opened on its page.
const PAGE = '/_kay/mail'
const LIST_URL = `${PAGE}.json`
const EVENTS_URL = `${PAGE}/events`

type Address = string | { name?: string | undefined, address: string }

interface SentMail {
  id: string
  sentAt: string
  to: Address[]
  subject: string
  html?: string | undefined
  text: string
}

function shown(address: Address): string {
  return typeof address === 'string' ? address : address.address
}

export default function mailDevTool(tool: DevTool): void {
  const tab = tool.tab({ id: 'mail', label: 'Mail', icon: 'mail', summary: count => `${count} mail${count === 1 ? '' : 's'}`, shown: show, hidden: hide })
  let asked = 0
  let live: EventSource | undefined
  const previewed = new Set<string>()
  const empty = (text: string) => {
    tab.count(0)
    tab.panel.replaceChildren(tool.make('div', 'empty', text))
  }
  const row = (mail: SentMail) => {
    const item = tool.make('div', 'row')
    const head = tool.make('div', '', '')
    const toggle = tool.make('button', 'link', mail.subject)
    const open = tool.make('a', 'link', 'Open')
    const to = tool.make('div', 'note', `${new Date(mail.sentAt).toLocaleTimeString('en-GB')} to ${mail.to.map(shown).join(', ')}`)
    const preview = tool.make('div')

    toggle.type = 'button'
    toggle.setAttribute('aria-expanded', String(previewed.has(mail.id)))
    open.href = `${PAGE}/${encodeURIComponent(mail.id)}`
    open.target = '_blank'
    open.rel = 'noopener'
    open.style.marginLeft = '10px'
    preview.hidden = !previewed.has(mail.id)

    const fill = () => {
      if (preview.firstChild !== null)
        return

      if (mail.html === undefined) {
        preview.append(tool.make('pre', 'json', mail.text))

        return
      }

      const frame = tool.make('iframe')

      frame.setAttribute('sandbox', '')
      frame.srcdoc = mail.html
      frame.title = mail.subject
      frame.style.cssText = 'width: 100%; height: 22rem; margin-top: 6px; border: 1px solid var(--line); border-radius: 6px; background: #fff'
      preview.append(frame)
    }

    if (previewed.has(mail.id))
      fill()

    toggle.addEventListener('click', () => {
      const opening = preview.hidden !== false

      fill()
      preview.hidden = !opening
      toggle.setAttribute('aria-expanded', String(opening))

      if (opening)
        previewed.add(mail.id)
      else
        previewed.delete(mail.id)
    })
    head.append(toggle, open)
    item.append(head, to, preview)

    return item
  }

  function show(): void {
    live ??= new EventSource(EVENTS_URL)
    live.onmessage = () => void refresh()
    void refresh()
  }

  function hide(): void {
    live?.close()
    live = undefined
  }

  async function refresh(): Promise<void> {
    const ask = ++asked
    let mails: SentMail[]

    try {
      const response = await fetch(LIST_URL, { cache: 'no-store' })

      if (response.status === 404) {
        if (ask === asked)
          empty('kayjs-mail keeps the outbox under `kay dev` alone, when the mailer sends to it.')

        return
      }

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      mails = await response.json() as SentMail[]
    }
    catch (error) {
      if (ask === asked)
        empty(`Could not read the outbox: ${error instanceof Error ? error.message : String(error)}`)

      return
    }

    if (ask !== asked)
      return

    if (mails.length === 0) {
      empty('No mail has been sent since the server started.')

      return
    }

    tab.count(mails.length)
    tab.panel.replaceChildren(...mails.toReversed().map(row))
  }

  void refresh()
}
