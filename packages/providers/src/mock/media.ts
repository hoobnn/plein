import { crc32, deflateSync } from 'node:zlib'

/** 纯色 PNG（RGB），不依赖图像库 */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Uint8Array {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8 位、RGB
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** 正弦波 WAV（16 位单声道） */
export function sineWav(seconds: number, frequency = 440, sampleRate = 16000): Uint8Array {
  const samples = Math.round(seconds * sampleRate)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVEfmt ', 8, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // 单声道
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 8000),
      44 + i * 2,
    )
  }
  return new Uint8Array(buf)
}

/** 由文本得到稳定的颜色，便于在画布上区分不同提示词的结果 */
export function colorOf(text: string): [number, number, number] {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return [(h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff]
}
