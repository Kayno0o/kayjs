export function GET() {
  return new Response('{}', { headers: { 'content-type': 'application/json', 'server-timing': 'upstream;dur=1' } })
}
