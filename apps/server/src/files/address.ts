import { BlockList, isIP } from 'node:net'

/**
 * 不允许服务端主动连接的地址：回环、私网、链路本地（含云厂商元数据 169.254.169.254）、
 * 共享地址空间、组播与保留段。外部 AI 给的 URL 只能指向公网。
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['100::', 64],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6')

/** ::ffff:a.b.c.d / ::ffff:7f00:1 / 64:ff9b::a.b.c.d 这类内嵌 IPv4 的写法，取出内嵌的 IPv4 */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase()
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return dotted[1]!
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex) {
    const hi = parseInt(hex[1]!, 16)
    const lo = parseInt(hex[2]!, 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

/** true = 不允许连接。不是合法 IP 的一律当作不允许。 */
export function isBlockedAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]!
  const family = isIP(bare)
  if (!family) return true
  const inner = family === 6 ? embeddedV4(bare) : null
  if (inner) return blocked.check(inner, 'ipv4')
  return blocked.check(bare, family === 4 ? 'ipv4' : 'ipv6')
}
