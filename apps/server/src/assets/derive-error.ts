/** 参数问题、素材类型和本机能力问题分别映射到可恢复的 HTTP 错误。 */
export class DeriveError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'unsupported' | 'no_ffmpeg',
    message: string,
  ) {
    super(message)
  }
}
