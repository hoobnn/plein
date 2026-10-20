import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test, type Page } from '@playwright/test'
import { elements, newProject, waitEngine } from './canvas'

const { zipSync } = createRequire(new URL('../apps/web/package.json', import.meta.url))(
  'fflate',
) as {
  zipSync(files: Record<string, Uint8Array>): Uint8Array
}
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const p = (text: string, props = '') => `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`
function docx(body: string, name = '中文参考.docx') {
  return {
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(
      zipSync({
        'word/document.xml': new TextEncoder().encode(
          `<w:document xmlns:w="${ns}"><w:body>${body}</w:body></w:document>`,
        ),
      }),
    ),
  }
}
async function upload(page: Page, files: ReturnType<typeof docx>[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '上传', exact: true }).click()
  await (await chooser).setFiles(files)
}
async function references(page: Page) {
  return page.evaluate(() =>
    [...window.__plein.engine.doc.elements()]
      .filter((el) => el.kind === 'markdown')
      .map((el) => ({ name: el.name, text: window.__plein.engine.doc.getText(el.id)?.toString() })),
  )
}

test('DOCX 本地保留中文段落、列表、表格与来源，刷新持久化且一步撤销', async ({ page }) => {
  await newProject(page)
  const uploads: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/api/assets')) uploads.push(r.url())
  })
  const listed = '<w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr>'
  const body =
    p('青年宣讲') +
    p('第一段中文') +
    p('列表内容', listed) +
    '<w:tbl><w:tr><w:tc>' +
    p('主题') +
    '</w:tc><w:tc>' +
    p('说明') +
    '</w:tc></w:tr>' +
    '<w:tr><w:tc>' +
    p('青年|行动') +
    '</w:tc><w:tc>' +
    p('第一行') +
    p('第二行') +
    '</w:tc></w:tr></w:tbl>' +
    p('![外部图片](https://example.invalid/private.png) # *字面文本*')
  await upload(page, [docx(body)])
  await expect.poll(async () => (await references(page)).length).toBe(1)
  const before = await references(page)
  expect(before[0]!.name).toBe('中文参考.docx')
  expect(before[0]!.text).toContain('来源：中文参考\\.docx')
  expect(before[0]!.text).toContain('  - 列表内容')
  expect(before[0]!.text).toContain('| 青年\\|行动 | 第一行 / 第二行 |')
  await expect(page.locator('.plein-md-scroll table')).toContainText('青年|行动')
  await expect(page.locator('.plein-md-scroll table')).toContainText('第一行 / 第二行')
  await expect(page.locator('[data-markdown-id] img')).toHaveCount(0)
  expect(uploads).toEqual([])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await references(page)).length).toBe(0)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => references(page)).toEqual(before)
  await page.reload()
  await waitEngine(page)
  expect(await references(page)).toEqual(before)
})

test('DOCX 损坏、空正文和旧 DOC 提供可读错误，不上传或生成空卡片', async ({ page }) => {
  await newProject(page)
  await upload(page, [
    { name: '损坏.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('bad zip') },
    docx(''),
    { name: '旧文件.doc', mimeType: 'application/msword', buffer: Buffer.from('old') },
  ])
  await expect(page.getByText('3 个文件未导入：', { exact: false })).toBeVisible()
  await expect(page.getByText('请确认文件未损坏、未加密', { exact: false })).toBeVisible()
  expect(await references(page)).toEqual([])
})

test('DOCX 正文和表格超限时明确拒绝，不静默截断', async ({ page }) => {
  await newProject(page)
  await upload(page, [
    docx(p('文'.repeat(200_001)), '超长.docx'),
    docx('<w:tbl><w:tr>' + '<w:tc/>'.repeat(101) + '</w:tr></w:tbl>', '超宽表格.docx'),
    docx(p('文'.repeat(8 * 1024 * 1024)), '解压超限.docx'),
  ])
  await expect(page.getByText('未导入或截断', { exact: false })).toBeVisible()
  await expect(page.getByText('表格过大', { exact: false })).toBeVisible()
  await expect(page.getByText('解压后超过 8 MiB', { exact: false })).toBeVisible()
  expect(await references(page)).toEqual([])
})

// 可选真实文件验收；正文仅留在隔离的本地测试数据中，不进入仓库或第三方。
test('实际中文参考的每个非空段落与列表均保留', async ({ page, request }) => {
  const path = process.env.PLEIN_DOCX_REFERENCE
  test.skip(!path, '设置 PLEIN_DOCX_REFERENCE 后验证本地参考原件')
  const expected = JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import zipfile,xml.etree.ElementTree as E,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 r=E.fromstring(z.read('word/document.xml')); ns={'w':'${ns}'}
 print(json.dumps([''.join(t.text or '' for t in p.findall('.//w:t',ns)).strip() for p in r.findall('.//w:p',ns) if p.findall('.//w:t',ns)],ensure_ascii=False))
`,
        path!,
      ],
      { encoding: 'utf8' },
    ),
  ) as string[]
  await newProject(page)
  const name = path!.split('/').at(-1)!
  await upload(page, [{ name, mimeType: 'application/octet-stream', buffer: readFileSync(path!) }])
  await expect.poll(async () => (await references(page)).length).toBe(1)
  const refs = await references(page)
  expect(refs[0]!.name).toBe(name)
  const rendered = await page.locator('[data-markdown-id]').innerText()
  for (const paragraph of expected.filter(Boolean)) expect(rendered).toContain(paragraph)
  expect(refs[0]!.text!.match(/^\s*- /gm)?.length).toBe(116)
  const id = (await elements(page)).find((el) => el.kind === 'markdown')!.id
  const canvasId = new URL(page.url()).hash.split('/')[2]!
  const { token } = (await (await request.post('/api/mcp/external')).json()) as { token: string }
  let offset = 0,
    full = '',
    version: string | undefined
  try {
    do {
      const res = await request.post('/mcp', {
        headers: { authorization: `Bearer ${token}` },
        data: {
          jsonrpc: '2.0',
          id: offset + 1,
          method: 'tools/call',
          params: {
            name: 'get_element_field',
            arguments: {
              canvas_id: canvasId,
              id,
              field_path: '/text',
              text_offset: offset,
              text_limit: 1000,
              ...(version ? { expected_version: version } : {}),
            },
          },
        },
      })
      const reply = (await res.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> }
      }
      expect(reply.result.isError).not.toBe(true)
      const part = JSON.parse(reply.result.content[0]!.text) as {
        value: string
        version: string
        complete: boolean
        next_text_offset?: number
      }
      full += part.value
      version = part.version
      offset = part.next_text_offset ?? -1
      expect(part.complete).toBe(offset === -1)
    } while (offset >= 0)
    expect(full).toBe(refs[0]!.text)
  } finally {
    await request.delete('/api/mcp/external')
  }
  expect((await elements(page)).filter((el) => el.kind === 'markdown')).toHaveLength(1)
})
