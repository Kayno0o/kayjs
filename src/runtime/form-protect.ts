// Written out here and not imported from `./markers` and `./action-form`: a lazy chunk importing them makes the eager one export their names.
const ISLAND = 'slot[data-component]'
const STAMP_FIELD = 'kay_since'

// What a form an island builds in the browser asks its action for, so it carries what the server writes into the forms it renders: the honeypot and the stamp `minTime` reads.
// A form the server rendered holds both already, and one outside an island is always the server's.
const OWN = `input[name="${STAMP_FIELD}"], input[data-1p-ignore]`

// The answers with no stamp, which hold for every form of the action; one with a stamp is dated by its form's focus.
const unstamped = new Map<string, Promise<string>>()
const asked = new WeakMap<HTMLFormElement, Promise<void>>()

// Resolves once `form` holds its action's protection fields, or at once for a form that needs none.
// A failed request leaves the form as it is: the server refuses or accepts the post by its own rules.
export async function protectForm(form: HTMLFormElement, url: URL): Promise<void> {
  if (!form.closest(ISLAND) || form.querySelector(OWN))
    return

  let pending = asked.get(form)

  if (!pending)
    asked.set(form, pending = addFields(form, url.pathname))

  await pending
}

async function addFields(form: HTMLFormElement, path: string): Promise<void> {
  try {
    form.insertAdjacentHTML('beforeend', await fieldsOf(path))
  }
  catch {
    // The post goes without them.
  }
}

async function fieldsOf(path: string): Promise<string> {
  const known = unstamped.get(path)

  if (known)
    return known

  const request = read(path)

  unstamped.set(path, request)

  try {
    const html = await request

    if (html.includes(STAMP_FIELD))
      unstamped.delete(path)

    return html
  }
  catch (error) {
    unstamped.delete(path)

    throw error
  }
}

async function read(path: string): Promise<string> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })

  if (!response.ok)
    throw new Error(String(response.status))

  return ((await response.json()) as { html: string }).html
}
