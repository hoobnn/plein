// 首屏连线按节点实际位置画；成片的声音开关；复制命令

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

const video = document.querySelector('.n-final video')
const sound = document.querySelector('.sound')
sound?.addEventListener('click', () => {
  video.muted = !video.muted
  if (!video.muted) video.play()
  sound.textContent = video.muted ? sound.dataset.on : sound.dataset.off
  sound.setAttribute('aria-pressed', String(!video.muted))
})

document.querySelectorAll('.cmd button').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.parentElement.querySelector('pre').textContent
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = button.dataset.done
    } catch {
      button.textContent = button.dataset.fail
    }
    setTimeout(() => {
      button.textContent = button.dataset.label
    }, 2000)
  })
})
