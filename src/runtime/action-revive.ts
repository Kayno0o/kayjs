declare const KAY_NO_ACTION_PROPS: true | undefined

// The marker devalue writes for an action in an island's props: wire.ts holds the type, which this module repeats rather than import, as it would bring the whole decoder into the chunk every page loads.
const MARKED = '["Action",'

let loading: Promise<void> | undefined

async function install(): Promise<void> {
  (await import('./action-reviver')).reviveActions()
}

// Installs the reviver of the actions an island's props hold before they are read, loading the code building their stubs only for a page that passes one.
// A build of an app that declares no action and uses no kay library defines `KAY_NO_ACTION_PROPS`, and carries none of it.
export function reviveActionsIn(text: string | undefined): Promise<void> | undefined {
  return typeof KAY_NO_ACTION_PROPS === 'undefined' && text?.includes(MARKED) ? loading ??= install() : undefined
}

// The same for every island a page about to be swapped in hands props.
export function reviveActionsOf(page: ParentNode): Promise<void> | undefined {
  return typeof KAY_NO_ACTION_PROPS === 'undefined' && page.querySelector(`[data-props*='${MARKED}']`) !== null ? reviveActionsIn(MARKED) : undefined
}
