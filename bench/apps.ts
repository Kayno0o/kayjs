export const APPS = ['kay', 'solid', 'svelte', 'astro', 'next', 'nuxt'] as const

export type AppName = typeof APPS[number]

// Next serves only through its own HTTP server, so its renders would carry a socket round trip the others never pay: its server rendering is not timed.
export const IN_PROCESS_APPS = APPS.filter(app => app !== 'next')

export interface BenchApp {
  handle: (request: Request) => Promise<Response>
}

export function isApp(name: string | undefined): name is AppName {
  return APPS.includes(name as AppName)
}

// Each app lives in its own package, so it is loaded in its own process, with its own dependencies.
export async function loadApp(name: AppName): Promise<BenchApp> {
  const { createApp } = await import(`./apps/${name}/app.ts`) as { createApp: () => Promise<BenchApp> }

  return createApp()
}

export function appFromArgs(): AppName {
  const name = Bun.argv[2]

  if (!isApp(name))
    throw new Error(`Expected an app name: ${APPS.join(', ')}`)

  return name
}
