// An SVG under a name not ending in `.svg`, as a handler or an extensionless route serves one.
export function GET() {
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#1565a0"/></svg>', { headers: { 'content-type': 'image/svg+xml' } })
}
