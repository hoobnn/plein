import { Switch as Base } from '@base-ui/react/switch'

/** 开关（Base UI Switch）：开 = accent 底，圆钮弹性滑到右边；点它不会冒泡到所在的行 */
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange(next: boolean): void
}) {
  return (
    <Base.Root
      checked={checked}
      disabled={disabled}
      aria-label={label}
      nativeButton
      render={<button type="button" />}
      onClick={(e) => e.stopPropagation()}
      onCheckedChange={(next) => onChange(next)}
      className="ui-switch"
    >
      <Base.Thumb />
    </Base.Root>
  )
}
