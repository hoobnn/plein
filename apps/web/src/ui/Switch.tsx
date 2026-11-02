import { Switch as Base } from '@base-ui/react/switch'
import { cn } from './cn'

/** Nova 开关（Base UI Switch）：保留受控接口；点它不会冒泡到所在的行。 */
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
      data-slot="switch"
      className={cn(
        'peer group/switch relative inline-flex h-(--switch-h) w-(--switch-w) shrink-0 items-center rounded-full border border-transparent transition-colors data-checked:bg-primary data-unchecked:bg-surface-3 data-disabled:cursor-not-allowed data-disabled:opacity-40',
      )}
    >
      <Base.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-white ring-0 transition-transform data-checked:translate-x-3.5 data-checked:bg-on-primary data-unchecked:translate-x-0"
      />
    </Base.Root>
  )
}
