// 检查仓库里的全部 Markdown（git 跟踪的文件），规则在 .markdownlint.jsonc；--fix 自动修复能修的项。
// 直接用 markdownlint 核心库，不用 markdownlint-cli2：后者经 micromatch 带进有漏洞且无修复版本的 braces。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { applyFixes } from 'markdownlint'
import { lint } from 'markdownlint/promise'

const fix = process.argv.includes('--fix')
// 配置文件只用到整行注释和末尾逗号
const config = JSON.parse(
  readFileSync('.markdownlint.jsonc', 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1'),
)
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  {
    encoding: 'utf8',
  },
)
  .split('\n')
  .filter(Boolean)

const results = await lint({ files, config })
let issues = 0
for (const file of files) {
  let errors = results[file]
  if (fix && errors.some((e) => e.fixInfo)) {
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, applyFixes(text, errors))
    errors = (await lint({ strings: { [file]: readFileSync(file, 'utf8') }, config }))[file]
  }
  for (const e of errors) {
    issues++
    const detail = [e.errorDetail, e.errorContext && `[${e.errorContext}]`]
      .filter(Boolean)
      .join(' ')
    console.log(
      `${file}:${e.lineNumber} ${e.ruleNames.join('/')} ${e.ruleDescription}${detail ? ` ${detail}` : ''}`,
    )
  }
}
console.log(`markdownlint: ${files.length} 个文件，${issues} 个问题`)
process.exitCode = issues ? 1 : 0
