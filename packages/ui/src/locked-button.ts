// What a locked button gives up besides `disabled`: its press and the popover or dialog it would open by itself, since only a disabled button leaves those alone.
const pressAttributes = new Set(['onClick', 'popovertarget', 'popovertargetaction', 'commandfor', 'command'])

// A button written `aria-disabled` in place of `disabled`: still a tab stop, but plain and deaf to its press, a popover and a command.
export function lockedButton<T extends object>(attributes: T) {
  const kept = Object.fromEntries(Object.entries(attributes).filter(([name]) => !pressAttributes.has(name) && name !== 'disabled'))

  return { ...kept, 'type': 'button', 'aria-disabled': 'true' } as T & { 'type': 'button', 'aria-disabled': 'true' }
}
