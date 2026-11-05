import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

it('draws a control without a value with no option selected and no chip ticked', async () => {
  const site = await testSite({ root: `${import.meta.dir}/fixture`, extensions: [ui()], islands: false })

  try {
    const html = (await site.visit('/no-value')).html
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'))

    expect(form).toContain('<select')
    expect(form).not.toMatch(/\sselected[\s=>]/)
    // The groups that must start on one option draw it checked, the first that is not disabled.
    expect(form.match(/\schecked[\s=>]/g)).toHaveLength(2)
    expect(form).not.toMatch(/name="(chips|stars)"[^>]*\schecked/)
  }
  finally {
    await site.close()
  }
}, 60_000)
