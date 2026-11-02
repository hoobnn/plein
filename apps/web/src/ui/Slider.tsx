import { Slider as Base } from '@base-ui/react/slider'
import type { FocusEventHandler, KeyboardEventHandler, PointerEventHandler } from 'react'
import { cn } from './cn'

/** Nova 单值滑块（Base UI Slider）：拖动时预览，提交回调只在交互完成时触发。 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  largeStep,
  onValueChange,
  onValueCommitted,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-valuetext': ariaValueText,
  onPointerDown,
  onKeyDown,
  onKeyUp,
  onBlur,
}: {
  value: number
  min?: number
  max?: number
  step?: number | 'any'
  largeStep?: number
  onValueChange?: (value: number) => void
  onValueCommitted?: (value: number) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-valuetext'?: string
  onPointerDown?: PointerEventHandler<HTMLDivElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  onKeyUp?: KeyboardEventHandler<HTMLDivElement>
  onBlur?: FocusEventHandler<HTMLInputElement>
}) {
  return (
    <Base.Root
      className={cn(
        'data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full',
        className,
      )}
      data-slot="slider"
      value={value}
      min={min}
      max={max}
      step={step === 'any' ? Number.EPSILON : step}
      largeStep={largeStep}
      disabled={disabled}
      onValueChange={onValueChange}
      onValueCommitted={onValueCommitted}
      onPointerDown={onPointerDown}
    >
      <Base.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-40 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-40 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col">
        <Base.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-full bg-surface-3 select-none data-[orientation=horizontal]:h-1 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1"
        >
          <Base.Indicator
            data-slot="slider-range"
            className="bg-primary select-none data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          />
        </Base.Track>
        <Base.Thumb
          data-slot="slider-thumb"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-valuetext={ariaValueText}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={onBlur}
          className="relative block size-3 shrink-0 rounded-full border border-accent bg-white ring-accent-soft transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-none active:ring-3 disabled:pointer-events-none disabled:opacity-40"
        />
      </Base.Control>
    </Base.Root>
  )
}
