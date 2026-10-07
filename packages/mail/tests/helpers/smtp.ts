import type { Socket, TCPSocketListener } from 'bun'

export interface Received {
  from: string
  to: string[]
  data: string
}

interface Session {
  buffer: string
  mail?: Received
  reading: boolean
}

// An SMTP server answering just enough of the protocol for a client to hand it one message per transaction, kept in `received`, and the names clients greeted it with in `greetings`.
export function startSmtp(port = 0): { received: Received[], greetings: string[], port: number, stop: () => void } {
  const received: Received[] = []
  const greetings: string[] = []
  const listener: TCPSocketListener<Session> = Bun.listen<Session>({
    hostname: '127.0.0.1',
    port,
    socket: {
      open: (socket) => {
        socket.data = { buffer: '', reading: false }
        socket.write('220 stub ESMTP\r\n')
      },
      data: (socket, chunk) => {
        socket.data.buffer += chunk.toString()

        for (let end = socket.data.buffer.indexOf('\r\n'); end !== -1; end = socket.data.buffer.indexOf('\r\n')) {
          const line = socket.data.buffer.slice(0, end)

          socket.data.buffer = socket.data.buffer.slice(end + 2)
          answer(socket, line, received, greetings)
        }
      },
    },
  })

  return { received, greetings, port: listener.port, stop: () => listener.stop(true) }
}

function answer(socket: Socket<Session>, line: string, received: Received[], greetings: string[]): void {
  const session = socket.data

  if (session.reading) {
    if (line === '.') {
      session.reading = false
      received.push(session.mail!)
      session.mail = undefined
      socket.write('250 queued\r\n')
    }
    else {
      session.mail!.data += `${line.startsWith('..') ? line.slice(1) : line}\n`
    }

    return
  }

  const command = line.slice(0, 4).toUpperCase()

  if (command === 'EHLO' || command === 'HELO') {
    greetings.push(line.slice(5))
    socket.write('250 stub\r\n')
  }
  else if (command === 'MAIL') {
    session.mail = { from: line.slice(10), to: [], data: '' }
  }
  else if (command === 'RCPT') {
    session.mail?.to.push(line.slice(8))
  }
  else if (command === 'DATA') {
    session.reading = true
  }

  if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP')
    socket.write('250 ok\r\n')
  else if (command === 'DATA')
    socket.write('354 go ahead\r\n')
  else if (command === 'QUIT')
    socket.end('221 bye\r\n')
  else if (command !== 'EHLO' && command !== 'HELO')
    socket.write('502 not implemented\r\n')
}

// A received message's body, or in a multipart one its `type` part, as its sender wrote it, quoted-printable decoded.
export function bodyText(mail: Received, type = 'text/plain'): string {
  const boundary = (/boundary="([^"]+)"/).exec(mail.data)?.[1]
  const entity = boundary === undefined ? mail.data : mail.data.split(`--${boundary}`).find(part => part.includes(`Content-Type: ${type}`))?.trimStart() ?? ''
  const split = entity.indexOf('\n\n')
  const body = entity.slice(split + 2)

  if (!(/^Content-Transfer-Encoding: quoted-printable$/im).test(entity.slice(0, split)))
    return body

  const bytes = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

  return new TextDecoder().decode(Uint8Array.from(bytes, char => char.charCodeAt(0)))
}
