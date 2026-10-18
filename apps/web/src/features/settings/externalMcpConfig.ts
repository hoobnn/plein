export type Client = 'claude-code' | 'json' | 'claude-desktop'

/** mcp-remote 从环境变量取请求头，避免参数里的空格在部分系统上被拆开 */
const AUTH_ARG = ['Authorization:$', '{AUTH_HEADER}'].join('')

/** 各家客户端的接入配置 */
export function snippet(client: Client, url: string, token: string) {
  if (client === 'claude-code')
    return `claude mcp add --transport http plein ${url} --header "Authorization: Bearer ${token}"`
  const server =
    client === 'json'
      ? { url, headers: { Authorization: `Bearer ${token}` } }
      : // Claude Desktop 的配置文件只接本机命令，经 mcp-remote 转到 HTTP
        {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', AUTH_ARG],
          env: { AUTH_HEADER: `Bearer ${token}` },
        }
  return JSON.stringify({ mcpServers: { plein: server } }, null, 2)
}
