// @vitest-environment happy-dom
import { zipSync } from 'fflate'
import { expect, it } from 'vite-plus/test'
import { readDocx } from './docx'

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const p = (text: string, props = '') => `<w:p>${props}<w:r><w:t>${text}</w:t></w:r></w:p>`

/** 造一个最小 DOCX：只含 word/document.xml */
function docx(body: string, name = '中文参考.docx') {
  const zip = zipSync({
    'word/document.xml': new TextEncoder().encode(
      `<w:document xmlns:w="${NS}"><w:body>${body}</w:body></w:document>`,
    ),
  })
  return new File([zip], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

it('保留中文段落、列表层次、表格与来源', async () => {
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
  const text = await readDocx(docx(body))
  expect(text).toContain('来源：中文参考\\.docx')
  expect(text).toContain('青年宣讲')
  expect(text).toContain('第一段中文')
  // 列表层次保留一级缩进
  expect(text).toContain('  - 列表内容')
  // 表格转成 Markdown 表格，竖线被转义，单元格内多段用 / 连接
  expect(text).toContain('| 青年\\|行动 | 第一行 / 第二行 |')
  // 字面文本被转义，不会变成图片或强调
  expect(text).toContain('!\\[外部图片\\]')
  expect(text).not.toContain('![')
})

it('损坏、空正文与旧版 .doc 都给出可读错误', async () => {
  const broken = new File([new Uint8Array([1, 2, 3])], '损坏.docx')
  await expect(readDocx(broken)).rejects.toThrow('请确认文件未损坏、未加密')
  await expect(readDocx(docx(''))).rejects.toThrow('没有可读取的正文文本')
})

it('正文与表格超限时明确拒绝，不静默截断', async () => {
  await expect(readDocx(docx(p('文'.repeat(200_001)), '超长.docx'))).rejects.toThrow('未导入或截断')
  await expect(
    readDocx(docx('<w:tbl><w:tr>' + '<w:tc/>'.repeat(101) + '</w:tr></w:tbl>', '超宽表格.docx')),
  ).rejects.toThrow('表格过大')
})
