// Beside tools.ts, which sits at its size baseline. The flags of `kay add` for a call: a preview unless it applies, and no install unless `install: true` asks, which only an applied call may, as a preview installs nothing.
export function addFlags(args: Record<string, unknown>, apply: boolean): string[] {
  if (args.install !== undefined && args.install !== false && (args.install !== true || !apply))
    throw new Error('install takes true or false, and needs apply: a preview installs nothing')

  return [...apply ? [] : ['--dry-run'], ...args.install === true ? [] : ['--no-install']]
}
