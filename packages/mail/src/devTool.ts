import type { DevTool } from 'kay/dev-tool'

// The dev tool's Mail tab, a browser module kay loads on dev pages: the mails sent to the outbox, each previewed in place or opened on its page, the "Send for real" switch and the app's mail templates.
const PAGE = '/_kay/mail'
const LIST_URL = `${PAGE}.json`
const EVENTS_URL = `${PAGE}/events`
const DELIVERY_URL = `${PAGE}/delivery`
const CLEAR_URL = `${PAGE}/clear`
const TEMPLATES_URL = `${PAGE}/samples.json`
const TEMPLATE_PAGE = `${PAGE}/samples`
const REFUSED = /^Refused: /

type Address = string | { name?: string | undefined, address: string }

interface SentMail {
  id: string
  sentAt: string
  to: Address[]
  subject: string
  html?: string | undefined
  text: string
  relayed?: { to: string, error?: string } | undefined
}

// What the server says of the "Send for real" switch.
interface Delivery {
  on: boolean
  to?: string
  server?: string
  offered?: string
  missing: string[]
  error?: string
}

function shown(address: Address): string {
  return typeof address === 'string' ? address : address.address
}

export default function mailDevTool(tool: DevTool): void {
  const tab = tool.tab({ id: 'mail', label: 'Mail', icon: 'mail', summary: count => `${count} mail${count === 1 ? '' : 's'}`, shown: show, hidden: hide })
  let asked = 0
  let live: EventSource | undefined
  let mailCount = 0
  let delivering: string | undefined
  let known: Delivery | undefined
  const previewed = new Set<string>()
  const sections = tool.make('div', 'stack')
  const switchBox = tool.make('div', 'stack')
  const list = tool.make('div')
  const templates = tool.make('div')

  sections.append(switchBox, list, templates)
  tab.panel.append(sections)

  // The count is the mails kept, toned and noted while the switch delivers them for real, so it shows from any tab.
  const counted = (count: number) => {
    mailCount = count

    if (delivering === undefined)
      tab.count(count)
    else
      tab.count(count, 'warn', `${count} mail${count === 1 ? '' : 's'}, delivered to ${delivering}`)
  }
  // The outbox is not there, so neither are the switch nor the templates.
  const gone = (text: string) => {
    known = undefined
    delivering = undefined
    counted(0)
    list.replaceChildren(tool.make('div', 'empty', text))
    switchBox.replaceChildren()
    templates.replaceChildren()
  }
  const heading = (text: string) => tool.make('h3', 'heading', text)
  const row = (mail: SentMail) => {
    const item = tool.make('div', 'row')
    const head = tool.make('div', '', '')
    const toggle = tool.make('button', 'link', mail.subject)
    const open = tool.make('a', 'link', 'Open')
    const to = tool.make('div', 'note', `${new Date(mail.sentAt).toLocaleTimeString('en-GB')} to ${mail.to.map(shown).join(', ')}`)
    const preview = tool.make('div')
    const relayed = mail.relayed === undefined ? undefined : tool.make('div', mail.relayed.error === undefined ? 'note' : 'error', mail.relayed.error === undefined ? `Delivered to ${mail.relayed.to}` : `Not delivered to ${mail.relayed.to}: ${mail.relayed.error}`)

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
    item.append(head, to, ...relayed === undefined ? [] : [relayed], preview)

    return item
  }

  function show(): void {
    live ??= new EventSource(EVENTS_URL)
    live.onmessage = () => void refresh()
    void refresh()
    void loadDelivery()
    void loadTemplates()
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
          gone('kayjs-mail keeps the outbox under `kay dev` alone, when the mailer sends to it.')

        return
      }

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      mails = await response.json() as SentMail[]
    }
    catch (error) {
      if (ask === asked)
        gone(`Could not read the outbox: ${error instanceof Error ? error.message : String(error)}`)

      return
    }

    if (ask !== asked)
      return

    counted(mails.length)

    if (mails.length === 0) {
      list.replaceChildren(heading('Mails'), tool.make('div', 'empty', 'No mail has been sent since the server started.'))

      return
    }

    const clear = tool.make('button', 'tool', 'Clear')
    const bar = tool.make('div', 'actions')

    clear.type = 'button'
    clear.addEventListener('click', () => void empty(clear, bar))
    bar.append(clear)
    list.replaceChildren(heading('Mails'), bar, ...mails.toReversed().map(row))
  }

  async function empty(button: HTMLButtonElement, bar: HTMLElement): Promise<void> {
    button.disabled = true

    try {
      const response = await fetch(CLEAR_URL, { method: 'POST' })

      if (response.ok) {
        previewed.clear()
        await refresh()

        return
      }

      bar.append(tool.make('div', 'error', (await response.text()).replace(REFUSED, '')))
    }
    catch (error) {
      bar.append(tool.make('div', 'error', error instanceof Error ? error.message : String(error)))
    }

    button.disabled = false
  }

  async function post(to: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true

    try {
      const response = await fetch(DELIVERY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }) })

      if (!response.ok) {
        if (known !== undefined)
          drawSwitch(known, (await response.text()).replace(REFUSED, ''))

        return
      }

      drawSwitch(await response.json() as Delivery)
    }
    catch (error) {
      if (known !== undefined)
        drawSwitch(known, error instanceof Error ? error.message : String(error))
    }
  }

  function drawSwitch(state: Delivery, failure?: string): void {
    const box = tool.make('div', 'stack')
    const say = (className: string, text: string) => tool.make('div', className, text)

    known = state
    delivering = state.on ? state.to : undefined
    counted(mailCount)
    box.append(heading('Send for real'))

    if (failure !== undefined)
      box.append(say('error', failure))

    if (state.error !== undefined) {
      box.append(say('error', state.error))
    }
    else if (state.missing.length > 0) {
      box.append(say('note', `Set ${state.missing.join(' and ')} to deliver mails over SMTP, a relay's or a local mailpit's. Until then every mail stays in the outbox.`))
    }
    else if (state.on) {
      const off = tool.make('button', 'tool', 'Turn off')

      off.type = 'button'
      off.addEventListener('click', () => void post('', off))
      box.append(say('', `Every mail sent now is also delivered to ${state.to} over ${state.server}, never to its own recipients, with no cc or bcc.`), off)
    }
    else {
      const form = tool.make('form', 'actions')
      const search = tool.make('div', 'search')
      const input = tool.make('input')
      const on = tool.make('button', 'tool', 'Turn on')

      input.type = 'email'
      input.required = true
      input.name = 'to'
      input.value = state.offered ?? ''
      input.setAttribute('aria-label', `Address to deliver every mail to over ${state.server}`)
      input.placeholder = 'you@example.com'
      on.type = 'submit'
      search.append(tool.icon('mail'), input)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        void post(input.value.trim(), on)
      })
      form.append(search, on)
      box.append(say('note', `Every mail sent from then on is delivered to this one address over ${state.server}, never to its own recipients, and stays in the outbox.`), form)
    }

    switchBox.replaceChildren(box)
  }

  // The server answers no switch, so none is drawn and no mail is noted as delivered.
  function absent(): void {
    known = undefined
    delivering = undefined
    counted(mailCount)
    switchBox.replaceChildren()
  }

  async function loadDelivery(): Promise<void> {
    try {
      const response = await fetch(DELIVERY_URL, { cache: 'no-store' })

      if (response.ok)
        drawSwitch(await response.json() as Delivery)
      else
        absent()
    }
    catch {
      absent()
    }
  }

  async function loadTemplates(): Promise<void> {
    let files: string[]

    try {
      const response = await fetch(TEMPLATES_URL, { cache: 'no-store' })

      if (!response.ok) {
        templates.replaceChildren()

        return
      }

      files = await response.json() as string[]
    }
    catch {
      templates.replaceChildren()

      return
    }

    const rows = files.map((file) => {
      const item = tool.make('div', 'row')
      const open = tool.make('a', 'link', file)

      open.href = `${TEMPLATE_PAGE}?mail=${encodeURIComponent(file)}`
      open.target = '_blank'
      open.rel = 'noopener'
      item.append(open)

      return item
    })

    templates.replaceChildren(heading('Templates'), ...rows.length === 0 ? [tool.make('div', 'empty', 'No .kay mail under src/mails.')] : rows)
  }

  void refresh()
  void loadDelivery()
}
