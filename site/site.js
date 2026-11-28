// 首屏连线按节点实际位置画；复制命令

const board = document.querySelector('.board')
const svg = board?.querySelector('.wires')

function drawWires() {
  if (!board || !svg || getComputedStyle(svg).display === 'none') return
  const box = board.getBoundingClientRect()
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
  const target = board.querySelector('.port.in').getBoundingClientRect()
  const tx = target.left + target.width / 2 - box.left
  const ty = target.top + target.height / 2 - box.top
  const paths = svg.querySelectorAll('path')
  board.querySelectorAll('.port.out').forEach((port, i) => {
    const r = port.getBoundingClientRect()
    const sx = r.left + r.width / 2 - box.left
    const sy = r.top + r.height / 2 - box.top
    const dx = Math.max(40, (tx - sx) * 0.55)
    paths[i]?.setAttribute('d', `M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`)
  })
}

if (board) {
  new ResizeObserver(drawWires).observe(board)
  for (const img of board.querySelectorAll('img')) img.addEventListener('load', drawWires)
}

document.querySelectorAll('.cmd button').forEach((button) => {
  const command = button.parentElement.querySelector('pre')
  const label = button.querySelector('span')
  let resetTimer
  let latestRequest = 0
  button.hidden = false
  button.addEventListener('click', async () => {
    const request = ++latestRequest
    const focused = document.activeElement
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const offset = selection?.anchorOffset
    const end = selection?.focusNode
    const endOffset = selection?.focusOffset
    clearTimeout(resetTimer)
    try {
      await navigator.clipboard.writeText(command.textContent)
      if (request !== latestRequest) return
      label.textContent = button.dataset.done
    } catch {
      if (request !== latestRequest) return
      if (
        selection &&
        document.activeElement === focused &&
        selection.anchorNode === anchor &&
        selection.anchorOffset === offset &&
        selection.focusNode === end &&
        selection.focusOffset === endOffset
      ) {
        selection.selectAllChildren(command)
      }
      label.textContent = button.dataset.fail
    }
    resetTimer = setTimeout(() => {
      label.textContent = button.dataset.label
    }, 2000)
  })
})
