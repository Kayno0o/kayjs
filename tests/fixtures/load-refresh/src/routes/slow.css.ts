// A stylesheet that takes its time, so a swap waits for it after its page arrived.
export async function GET() {
  await Bun.sleep(1500)

  return new Response('/* slow */', { headers: { 'content-type': 'text/css' } })
}
