/** 档案里的图片悬停 / 选中时告诉外面换大图 */
export interface HeroControl {
  onPreview(assetId: string | null, caption?: string): void
  onPin(assetId: string | null, caption?: string): void
}
