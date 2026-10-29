import { ACTION_TYPE, serverWritten } from './wire'

const MARKED = `["${ACTION_TYPE}",`

// Installs the reviver of the actions an island's props hold before they are read, loading the code building their stubs only for a page that passes one, so the core chunk carries none.
export async function reviveActionsIn(text: string | undefined): Promise<void> {
  if (text?.includes(MARKED) && !(ACTION_TYPE in serverWritten))
    (await import('./action-reviver')).reviveActions()
}

// The same for every island a page about to be swapped in hands props.
export async function reviveActionsOf(page: ParentNode): Promise<void> {
  if (page.querySelector(`[data-props*='${MARKED}']`) !== null)
    await reviveActionsIn(MARKED)
}
