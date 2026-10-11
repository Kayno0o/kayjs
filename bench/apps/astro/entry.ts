import { createApp } from 'astro/app/entrypoint'

const app = createApp()

export async function handle(request: Request): Promise<Response> {
  return app.render(request)
}
