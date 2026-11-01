import { gzipSync, gunzipSync } from 'node:zlib'
import {
  ProviderError,
  type ProviderContext,
  type CapabilityInput,
  type TranscriptSegment,
} from '@plein/plugin-sdk'
import { asJson, redact } from '../shared/http'

export function asrFrame(type: number, sequence: number, payload: Uint8Array) {
  const compressed = gzipSync(payload)
  const header = Buffer.alloc(12)
  header[0] = 0x11
  header[1] = (type << 4) | (sequence < 0 ? 3 : 1)
  header[2] = type === 1 ? 0x11 : 0x01
  header.writeInt32BE(sequence, 4)
  header.writeUInt32BE(compressed.length, 8)
  return Buffer.concat([header, compressed])
}

export function asrPacket(bytes: Uint8Array) {
  const data = Buffer.from(bytes)
  const invalid = () =>
    new ProviderError('unavailable', 'Agent Plan 语音识别返回不完整数据', {
      outcome: 'unknown',
      retryable: false,
    })
  if (data.length < 8 || data[0]! >> 4 !== 1) throw invalid()
  const flags = data[1]! & 15,
    type = data[1]! >> 4
  let offset = (data[0]! & 15) * 4
  if (offset < 4) throw invalid()
  if (type === 15) {
    if (data.length < offset + 8) throw invalid()
    const code = data.readUInt32BE(offset)
    throw new ProviderError(
      code === 45000001 ? 'invalid_input' : 'unavailable',
      `Agent Plan 语音识别错误 ${code}`,
      { retryable: false },
    )
  }
  if (type !== 9) throw invalid()
  if (flags & 1) offset += 4
  if (flags & 4) offset += 4
  if (data.length < offset + 4) throw invalid()
  const size = data.readUInt32BE(offset)
  offset += 4
  if (offset + size !== data.length) throw invalid()
  let body = data.subarray(offset)
  if ((data[2]! & 15) === 1) body = gunzipSync(body, { maxOutputLength: 8 * 1024 * 1024 })
  if (data[2]! >> 4 !== 1) throw invalid()
  return { final: Boolean(flags & 2), data: asJson(JSON.parse(body.toString())) }
}

export async function transcribePlan(
  input: CapabilityInput<'audio.transcribe'>,
  ctx: ProviderContext,
) {
  if (!ctx.socket)
    throw new ProviderError('unavailable', '当前宿主不支持 Agent Plan 流式语音识别，请升级 Plein')
  const key = ctx.secret('ARK_AGENT_PLAN_API_KEY')
  if (!key) throw new ProviderError('auth', '请先配置 Agent Plan 专属 API Key')
  const asset = await ctx.files.read(input.audio)
  const format = (
    {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/ogg': 'ogg',
    } as Record<string, string>
  )[asset.mime]
  if (!format || !asset.data.length || asset.data.length > 100 * 1024 * 1024)
    throw new ProviderError(
      'invalid_input',
      'Agent Plan 识别支持非空 WAV、MP3、Ogg Opus 音频，最大 100 MB',
    )
  const requestId = ctx.submission?.requestId ?? crypto.randomUUID()
  ctx.log('Agent Plan 语音识别请求', { requestId })
  let socket: Awaited<ReturnType<NonNullable<ProviderContext['socket']>>> | undefined
  try {
    socket = await ctx.socket('wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream', {
      'X-Api-Key': key,
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
      'X-Api-Connect-Id': requestId,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    })
    const logId = socket.logId ? redact(socket.logId, [key]) : undefined
    ctx.submission?.response({ httpStatus: 101, ...(logId ? { logId } : {}) })
    if (logId) ctx.log('Agent Plan 语音识别平台日志', { requestId, logId })
    socket.send(
      asrFrame(
        1,
        1,
        Buffer.from(
          JSON.stringify({
            user: { uid: 'plein' },
            audio: {
              format,
              ...(format === 'ogg' ? { codec: 'opus' } : {}),
              ...(input.language ? { language: input.language } : {}),
            },
            request: {
              model_name: 'bigmodel',
              enable_itn: true,
              enable_punc: true,
              show_utterances: true,
            },
          }),
        ),
      ),
    )
    // 等待初始化确认后发送音频；并行接收，避免较长录音的响应积压。
    const initial = asrPacket(await socket.receive())
    if (initial.final) throw new ProviderError('unknown', '语音识别在发送音频前结束')
    const receiving = (async () => {
      for (;;) {
        const packet = asrPacket(await socket!.receive())
        if (!packet.final) continue
        const result = asJson(packet.data.result)
        if (typeof result.text !== 'string')
          throw new ProviderError('unknown', '语音识别结果缺少文本')
        const segments: TranscriptSegment[] = (
          Array.isArray(result.utterances) ? result.utterances : []
        )
          .map(asJson)
          .filter(
            (u) =>
              typeof u.text === 'string' &&
              typeof u.start_time === 'number' &&
              typeof u.end_time === 'number' &&
              u.end_time > u.start_time,
          )
          .map((u) => ({
            text: u.text as string,
            start: (u.start_time as number) / 1000,
            end: (u.end_time as number) / 1000,
          }))
        return {
          state: 'succeeded' as const,
          outputs: [
            { type: 'text' as const, text: result.text },
            ...(segments.length ? [{ type: 'json' as const, value: { segments } }] : []),
          ],
        }
      }
    })()
    // 发送过程失败时也消费接收端的拒绝；正常路径仍 await 并传播错误。
    void receiving.catch(() => {})
    let sequence = 2
    for (let offset = 0; offset < asset.data.length; offset += 32000) {
      const chunk = asset.data.subarray(offset, offset + 32000)
      const last = offset + chunk.length === asset.data.length
      socket.send(asrFrame(2, last ? -sequence : sequence, chunk))
      sequence++
    }
    return await receiving
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(
      ctx.signal.aborted ? 'cancelled' : 'unavailable',
      redact('Agent Plan 语音识别失败，结果未知', [key]),
      { outcome: 'unknown', retryable: false },
    )
  } finally {
    socket?.close()
  }
}
