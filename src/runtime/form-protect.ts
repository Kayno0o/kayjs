// Written out here and not imported from `./markers` and `./action-form`: a lazy chunk importing them makes the eager one export their names.
// `FIELDS_PREFIX` in `./wire` is the address the fields are asked at, in place of `/_kay/action/`.
const ISLAND = 'slot[data-component]'
const STAMP_FIELD = 'kay_since'
const FETCH_TIMEOUT_MS = 4000

// What a form an island builds in the browser asks its action for, so it carries what the server writes into the forms it renders: the honeypot and the stamp `minTime` reads.
// A form the server rendered holds both already, and one outside an island is always the server's.
const OWN = `input[name="${STAMP_FIELD}"], input[data-1p-ignore]`

// The answers with no stamp, which hold for every form of the action; one with a stamp is dated by its form's focus.
const unstamped = new Map<string, Promise<string>>()
// The fields added to a form and the action they are for, and the request under way for it.
const added = new WeakMap<HTMLFormElement, { path: string, nodes: ChildNode[] }>()
const asking = new WeakMap<HTMLFormElement, { path: string, done: Promise<void> }>()

// Resolves once `form` holds the protection fields of the action at `url`, or at once for a form that needs none.
// A failed or slow request leaves the form as it is, to be asked again at its next focus or post: the server refuses or accepts the post by its own rules.
export async function protectForm(form: HTMLFormElement, url: URL): Promise<void> {
  if (!form.closest(ISLAND))
    return

  const path = url.pathname
  const own = added.get(form)

  // The server's fields, or ours for this action still in the form: an island that drew the form again has dropped ours, and a submitter naming another action needs that one's.
  if (form.querySelector(OWN) && (own === undefined || (own.path === path && own.nodes.some(node => form.contains(node)))))
    return

  let request = asking.get(form)

  if (request?.path !== path)
    asking.set(form, request = { path, done: addFields(form, path) })

  await request.done
}

async function addFields(form: HTMLFormElement, path: string): Promise<void> {
  try {
    const html = await fieldsOf(path)
    const template = document.createElement('template')

    template.innerHTML = html
    for (const node of added.get(form)?.nodes ?? [])
      node.remove()

    const nodes = [...template.content.childNodes]

    form.append(...nodes)
    added.set(form, { path, nodes })
  }
  catch {
    // The post goes without them.
  }
  finally {
    asking.delete(form)
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
  const response = await fetch(path.replace('/_kay/action/', '/_kay/fields/'), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

  if (!response.ok)
    throw new Error(String(response.status))

  return ((await response.json()) as { html: string }).html
}
