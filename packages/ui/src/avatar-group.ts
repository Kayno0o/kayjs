export type AvatarStatus = 'online' | 'away' | 'busy' | 'offline'

// One person of an AvatarGroup: what an Avatar takes, with a `key` for the list to tell them apart by when two share a name.
export interface GroupedAvatar {
  key?: string | number | undefined
  name: string
  src?: string | null | undefined
  // Names the avatar for screen readers; the name by default, as the group's people are its content.
  label?: string | undefined
  // Makes the avatar, and the person's row in the overflow list, a link.
  href?: string | undefined
  status?: AvatarStatus | undefined
  statusLabel?: string | undefined
}
