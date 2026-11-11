// A redirect's headers are immutable.
export function GET() {
  return Response.redirect('http://localhost/open.json', 302)
}
