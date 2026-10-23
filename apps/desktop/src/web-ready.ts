/** 等 Vite 就绪；单次请求也受总期限约束，避免挂起响应阻断桌面启动。 */
export async function waitForWeb(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    }).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) return
    const remaining = deadline - Date.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(300, remaining)))
  }
  throw new Error(`开发页面在 ${timeoutMs / 1000} 秒内未就绪：${url}`)
}
