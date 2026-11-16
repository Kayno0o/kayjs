// An app's handler for an event and the component's own, the app's first, so a handler given through `panelProps` or `triggerProps` never replaces the one the component needs.
export function chained<Event>(app: ((event: Event) => unknown) | undefined, own: (event: Event) => unknown): (event: Event) => void {
  return (event) => {
    app?.(event)
    own(event)
  }
}
