import { describe, expect, it } from 'bun:test'
import { markdownHtml as clientMarkdown } from '../../../src/runtime/markdown.client'
import { closedFences, highlighting, safeCode } from '../src/highlight'
import { createReply } from '../src/reply'

const FENCED = 'Intro\n\n```ts\nconst a = 1 < 2 && "x"\n```\n\nAfter'

describe('closedFences', () => {
  it('lists the blocks with their closing fence and leaves an open one out', () => {
    expect(closedFences(FENCED)).toEqual([{ source: '```ts\nconst a = 1 < 2 && "x"\n```', language: 'ts' }])
    expect(closedFences('```ts\nconst a')).toEqual([])
    expect(closedFences('```ts\nok\n```\n~~~\nopen')).toEqual([{ source: '```ts\nok\n```', language: 'ts' }])
  })

  it('closes a fence with a fence as long and of the same kind, alone on its line', () => {
    expect(closedFences('````md\n```\ninner\n```\n````')).toEqual([{ source: '````md\n```\ninner\n```\n````', language: 'md' }])
    expect(closedFences('```\na\n~~~\n```x\n')).toEqual([])
    expect(closedFences('```\r\na\r\n```\r\n')).toEqual([{ source: '```\r\na\r\n```\r', language: undefined }])
  })

  it('reads a fence in a list item or a quote, and skips an inline span opened with backticks', () => {
    expect(closedFences('- item\n  ```js\n  a\n  ```')).toHaveLength(1)
    expect(closedFences('> ```js\n> a\n> ```')).toHaveLength(1)
    expect(closedFences('```a`b\ntext\n```')).toEqual([])
  })
})

describe('safeCode', () => {
  it('keeps what a highlighter writes for code: classes, colours and the frame', () => {
    const html = '<div class="code"><pre class="shiki" style="background-color:var(--shiki-background);color:var(--shiki-foreground)" tabindex="0"><code><span class="line"><span style="color:var(--shiki-token-keyword)">const</span></span></code></pre></div>'

    expect(safeCode(html)).toBe(html)
  })

  it('keeps the variables of a Shiki dual theme and drops only the declarations that are not colours', () => {
    expect(safeCode('<span style="--shiki-light:#a;--shiki-dark:#b">x</span>')).toBe('<span style="--shiki-light:#a;--shiki-dark:#b">x</span>')
    expect(safeCode('<span style="color:#D73A49;--shiki-dark:#F97583;position:fixed">x</span>')).toBe('<span style="color:#D73A49;--shiki-dark:#F97583">x</span>')
    expect(safeCode('<span style="position:fixed">x</span>')).toBe('<span>x</span>')
  })

  it('drops what injects markup or loads something, whatever the highlighter wrote', () => {
    const hostile = '<pre><code><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><span onclick="a()" style="color:red;background:url(//evil/x)" class="k">y</span><span style="position:fixed;inset:0;color:red">z</span><span style="color:expression(alert(1))">w</span><button>b</button><iframe src="//evil"></iframe><span data-style="position:fixed">d</span></code></pre>'
    const safe = safeCode(hostile)

    expect(safe).not.toMatch(/<script|<img|<a |<button|<iframe|onclick|onerror|javascript:|url\(|position|expression/)
    expect(safe).toContain('class="k"')
  })

  it('keeps hostile code text as text', () => {
    const safe = safeCode('<pre><code>&lt;img src=x onerror=alert(1)&gt; data-style="position:fixed" style="color:red"</code></pre>')

    expect(safe).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(safe).toContain('data-style="position:fixed"')
  })
})

describe('highlighting', () => {
  const upper = (code: string, language: string | undefined) => `<pre><code>${language}:${code.toUpperCase()}</code></pre>`

  it('highlights a block once, when it is closed, as the chat renders it', async () => {
    const next = highlighting(async () => upper)
    const [block] = await next(FENCED)

    expect(block!.html).toContain('ts:CONST A = 1 &lt; 2 &amp;&amp; "X"')
    expect(clientMarkdown(FENCED)).toContain(block!.markup)
    expect(await next(FENCED)).toEqual([])
    expect(await next('```ts\nopen')).toEqual([])
  })

  it('gives the highlighter a language that is a plain word only, and swaps two blocks of one code in two languages each', async () => {
    const languages: (string | undefined)[] = []
    const blocks = await highlighting(async () => (_code, language) => {
      languages.push(language)

      return `<pre><code>${language}</code></pre>`
    })('```x fixed inset-0\na\n```\n\n```ts\na\n```\n\n```py\na\n```\n\n```ts\na\n```')

    expect(languages).toEqual(['x', 'ts', 'py', 'ts'])
    expect(blocks.map(block => block.html)).toEqual(['<pre><code>x</code></pre>', '<pre><code>ts</code></pre>', '<pre><code>py</code></pre>', '<pre><code>ts</code></pre>'])
  })

  it('highlights nothing without a highlighter, and a block stays plain when the highlighter throws', async () => {
    expect(await highlighting(async () => undefined)(FENCED)).toEqual([])
    expect(await highlighting(async () => () => {
      throw new Error('no grammar')
    })(FENCED)).toEqual([])
  })

  it('sanitizes what the highlighter returns', async () => {
    const [block] = await highlighting(async () => () => '<pre><script>x</script><span style="color:red" onclick="a()">y</span></pre>')(FENCED)

    expect(block!.html).toBe('<pre><span style="color:red">y</span></pre>')
  })

  it('rides the progress stream of a reply, each block once', async () => {
    async function* pieces() {
      yield { text: 'A\n\n```ts\nx\n' }
      yield { text: '```\n\nB' }
      yield { text: '\n\n```\ny' }
    }

    const reply = createReply(pieces, [], () => highlighting(async () => upper))
    const seen = []

    for await (const progress of reply.progress())
      seen.push(progress)

    expect(seen.filter(progress => progress.code).map(progress => progress.code!.length)).toEqual([1])
    expect(seen.at(-1)!.text).toContain('```\ny')
  })
})
