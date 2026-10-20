/**
 * 本机 Electron 文本历史合同。只开隐藏测试窗口，不读取正式版或验收包的数据。
 * PLEIN_NATIVE_HISTORY_DIST=<vp build --mode e2e 的绝对目录> electron scripts/edit-history.contract.mjs
 * 可选 PLEIN_NATIVE_HISTORY_REPORT 保存 JSON；不使用或修改系统剪贴板。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'

const scripts = dirname(fileURLToPath(import.meta.url))
const root = resolve(scripts, '../../..')
const dist = process.env.PLEIN_NATIVE_HISTORY_DIST
if (!dist || !isAbsolute(dist))
  throw new Error('请指定 PLEIN_NATIVE_HISTORY_DIST 的 e2e 构建绝对目录')
const fingerprint = createHash('sha256')
  .update(readFileSync(join(dist, 'index.html')))
  .digest('hex')
const scratch = mkdtempSync(join(tmpdir(), 'plein-native-history-'))
app.setName('Plein Native History Contract')
mkdirSync(join(scratch, 'electron'))
app.setPath('userData', join(scratch, 'electron'))
app.on('window-all-closed', () => {})
const windows = new Set()
ipcMain.handle('plein:native-edit', (event, action) => {
  if (
    windows.has(event.sender.id) &&
    event.senderFrame === event.sender.mainFrame &&
    ['undo', 'redo', 'selectAll'].includes(action)
  )
    event.sender[action]()
})
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(win, expression) {
  for (let i = 0; i < 200; i++) {
    if (await win.webContents.executeJavaScript(expression)) return
    await pause(25)
  }
  throw new Error(`原生编辑合同等待超时：${expression}`)
}

let server
let exited
let serverLog = ''
const report = {
  electron: process.versions.electron,
  buildFingerprint: fingerprint,
  clipboardUsed: false,
  cases: [],
}
let exitCode = 1
async function run() {
  try {
    await app.whenReady()
    server = spawn(
      process.env.PLEIN_NATIVE_HISTORY_NODE ?? 'node',
      [
        '--import',
        join(root, 'apps/server/node_modules/tsx/dist/loader.mjs'),
        join(root, 'apps/server/src/main.ts'),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PLEIN_HOST: '127.0.0.1',
          PLEIN_PORT: '0',
          PLEIN_DATA_DIR: join(scratch, 'data'),
          PLEIN_WEB_DIST: dist,
          PLEIN_MOCK_PROVIDER: '1',
          PLEIN_AGENT: '0',
          PLEIN_AUTH: 'none',
          PLEIN_DESKTOP_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    exited = new Promise((done) => server.once('close', done))
    const base = await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('隔离服务启动超时')), 15000)
      const inspect = (data) => {
        serverLog += data.toString()
        const match = serverLog.match(/plein 已启动：(http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {
          clearTimeout(timer)
          done(match[1])
        }
      }
      server.stdout.on('data', inspect)
      server.stderr.on('data', inspect)
      server.once('error', (error) => {
        clearTimeout(timer)
        fail(error)
      })
      server.once('close', () => {
        clearTimeout(timer)
        fail(new Error('隔离服务提前退出'))
      })
    })
    for (const mode of ['menu', 'main', 'renderer'])
      for (const replace of [true, false]) {
        const win = new BrowserWindow({
          width: 1440,
          height: 900,
          show: false,
          webPreferences: {
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false,
            preload: join(scripts, 'edit-history-preload.cjs'),
          },
        })
        windows.add(win.webContents.id)
        try {
          await win.loadURL(base)
          await until(
            win,
            `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='新建项目')`,
          )
          await win.webContents.executeJavaScript(
            `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='新建项目').click()`,
          )
          await until(win, '!!window.__plein')
          const id = await win.webContents.executeJavaScript(
            `{const id=window.__plein.addNode({type:'plein/text',name:'native multiline',params:{text:'Base'},x:0,y:0});window.__plein.engine.selection.set([id]);id}`,
          )
          const insertedText = 'A\nB'
          const field = `document.querySelector('textarea[aria-label="提示词"]')`
          await until(win, `${field}?.value==='Base'`)
          await win.webContents.executeJavaScript(
            `{const t=${field};t.focus();${replace ? 't.select()' : 't.setSelectionRange(4,4)'};window.nativeHistoryEvents=[];t.addEventListener('input',e=>window.nativeHistoryEvents.push(e.inputType));document.execCommand('insertText',false,${JSON.stringify(insertedText)})}`,
          )
          const expected = replace ? insertedText : 'Base' + insertedText
          const value = () => win.webContents.executeJavaScript(`${field}.value`)
          const docValue = () =>
            win.webContents.executeJavaScript(
              `window.__plein.engine.doc.get(${JSON.stringify(id)}).params.text`,
            )
          await until(win, `${field}.value===${JSON.stringify(expected)}`)
          await until(
            win,
            `window.__plein.engine.doc.get(${JSON.stringify(id)}).params.text===${JSON.stringify(expected)}`,
          )
          const inserted = await value()
          const edit = async (action) => {
            const count = await win.webContents.executeJavaScript(
              'window.nativeHistoryEvents.length',
            )
            if (mode === 'menu') win.webContents.send('plein:menu-command', action)
            else if (mode === 'main') win.webContents[action]()
            else
              await win.webContents.executeJavaScript(
                `document.execCommand(${JSON.stringify(action)})`,
              )
            await until(win, `window.nativeHistoryEvents.length>${count}`)
            await until(
              win,
              `window.__plein.engine.doc.get(${JSON.stringify(id)}).params.text===${field}.value`,
            )
          }
          await edit('undo')
          const undone = await value()
          await edit('redo')
          const redone = await value()
          const stored = await docValue()
          const elements = await win.webContents.executeJavaScript(
            '[...window.__plein.engine.doc.elements()].length',
          )
          report.cases.push({
            mode,
            replace,
            inserted,
            undone,
            redone,
            stored,
            elements,
            passed:
              inserted === expected &&
              undone === 'Base' &&
              redone === expected &&
              stored === expected &&
              elements === 1,
          })
        } finally {
          windows.delete(win.webContents.id)
          win.destroy()
        }
      }
    report.passed = report.cases.length === 6 && report.cases.every((item) => item.passed)
    exitCode = report.passed ? 0 : 1
  } catch (error) {
    report.error = String(error.stack ?? error)
    report.serverLog = serverLog
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    if (process.env.PLEIN_NATIVE_HISTORY_REPORT)
      writeFileSync(process.env.PLEIN_NATIVE_HISTORY_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
    rmSync(scratch, { recursive: true, force: true })
    app.exit(exitCode)
  }
}
void run()
