// @vitest-environment happy-dom
import { useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { fireEvent, renderApp, screen } from '../testing/render'
import { type ObjectSchema, SchemaForm } from './SchemaForm'

/** 受控表单：记录每次提交的值，方便断言字段各自写到哪里 */
function renderForm(schema: ObjectSchema, initial: Record<string, unknown> = {}) {
  const submitted: Record<string, unknown>[] = []
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <SchemaForm
        schema={schema}
        value={value}
        onChange={(next) => {
          submitted.push(next)
          setValue(next)
        }}
      />
    )
  }
  const { user } = renderApp(<Harness />)
  return { submitted, user }
}

/** 选一个枚举值：打开下拉后点中对应选项 */
async function choose(user: ReturnType<typeof renderApp>['user'], label: string, option: string) {
  await user.click(screen.getByRole('combobox', { name: label }))
  const target = screen.getAllByRole('option').find((item) => item.textContent === option)
  if (!target) throw new Error(`没有这个选项：${option}`)
  await user.click(target)
}

/** 输入数字（只改草稿，不提交） */
function typeNumber(input: HTMLInputElement, text: string) {
  fireEvent.change(input, { target: { value: text } })
}

/** 失焦提交草稿 */
function commitNumber(input: HTMLInputElement) {
  fireEvent.focusOut(input)
}

describe('枚举字段', () => {
  const schema: ObjectSchema = {
    properties: {
      latencyMs: { type: 'integer', title: '模拟耗时（毫秒）', enum: [0, 100], default: 0 },
      queueMs: { type: 'integer', title: '排队枚举', enum: [0, 10] },
    },
  }

  it('零值显示为 0 而不是默认，选中后写入数字而不是字符串', async () => {
    const { submitted, user } = renderForm(schema)
    const field = screen.getByRole('combobox', { name: '模拟耗时（毫秒）' })
    expect(field.textContent).toBe('0')

    await choose(user, '模拟耗时（毫秒）', '100')
    expect(submitted.at(-1)).toEqual({ latencyMs: 100 })
    expect(typeof (submitted.at(-1) as { latencyMs: unknown }).latencyMs).toBe('number')
    expect(screen.getByRole('combobox', { name: '模拟耗时（毫秒）' }).textContent).toBe('100')
  })

  it('没有默认值的枚举提供默认选项，选回默认即删掉这个键', async () => {
    const { submitted, user } = renderForm(schema)
    const field = screen.getByRole('combobox', { name: '排队枚举' })
    expect(field.textContent).toBe('默认')

    await choose(user, '排队枚举', '10')
    expect(submitted.at(-1)).toEqual({ queueMs: 10 })
    await choose(user, '排队枚举', '默认')
    expect(submitted.at(-1)).toEqual({})
    expect(screen.getByRole('combobox', { name: '排队枚举' }).textContent).toBe('默认')
  })
})

describe('数值字段', () => {
  const schema: ObjectSchema = {
    properties: {
      temperature: { type: 'number', title: '温度', minimum: 0, maximum: 2, default: 1.25 },
    },
  }

  it('保留零值、失焦夹紧范围、清空恢复默认', () => {
    const { submitted } = renderForm(schema)
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '温度' })
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: '温度' })
    // 没有取值时输入框留空，占位符给出默认值
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('1.25')
    expect(slider.value).toBe('1.25')

    for (const [typed, expected] of [
      ['0', 0],
      ['2.8', 2],
      ['-0.2', 0],
      ['1.25', 1.25],
    ] as const) {
      typeNumber(input, typed)
      commitNumber(input)
      expect(submitted.at(-1)).toEqual({ temperature: expected })
      expect(input.value).toBe(String(expected))
      expect(slider.value).toBe(String(expected))
    }

    typeNumber(input, '')
    commitNumber(input)
    expect(submitted.at(-1)).toEqual({})
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('1.25')
    expect(slider.value).toBe('1.25')
  })

  it('滑块按步进调整数值并同步回输入框', () => {
    const { submitted } = renderForm(schema, { temperature: 1.25 })
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '温度' })
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: '温度' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(submitted.at(-1)).toEqual({ temperature: 1.27 })
    expect(input.value).toBe('1.27')
    expect(slider.value).toBe('1.27')
  })

  it('未完成数字不误当清空，保留原值并标出无效，修正后可以继续提交', () => {
    const { submitted } = renderForm(schema, { temperature: 1.1 })
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '温度' })
    typeNumber(input, '1e')
    expect(input.validity.badInput).toBe(true)
    commitNumber(input)
    expect(submitted).toHaveLength(0)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.value).toBe('1.1')
    const error = screen.getByRole('alert')
    expect(error.textContent).toContain('请输入有效数字')
    expect(input.getAttribute('aria-describedby')).toContain(error.id)

    typeNumber(input, '1.3')
    commitNumber(input)
    expect(submitted.at(-1)).toEqual({ temperature: 1.3 })
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()

    // 再写坏一次时滑块仍能清掉无效状态，按步进继续
    typeNumber(input, '1e')
    commitNumber(input)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.keyDown(screen.getByRole<HTMLInputElement>('slider', { name: '温度' }), {
      key: 'ArrowRight',
    })
    expect(submitted.at(-1)).toEqual({ temperature: 1.32 })
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('同名字段的身份', () => {
  it('模型专用与通用同名字段各自关联标签、说明和取值位置', async () => {
    const common: Record<string, unknown>[] = []
    const specific: Record<string, unknown>[] = []
    function Harness() {
      const [params, setParams] = useState<Record<string, unknown>>({ speed: 1 })
      const [options, setOptions] = useState<Record<string, unknown>>({ speed: 0.5 })
      return (
        <div>
          <SchemaForm
            schema={{
              properties: {
                speed: {
                  type: 'number',
                  title: '语速',
                  description: '通用倍率',
                  minimum: 0,
                  maximum: 3,
                },
              },
            }}
            value={params}
            onChange={(next) => {
              common.push(next)
              setParams(next)
            }}
          />
          <SchemaForm
            schema={{
              properties: {
                speed: {
                  type: 'number',
                  title: '模型专用语速',
                  description: '模型专用倍率',
                  minimum: 0,
                  maximum: 3,
                },
                flag: { type: 'boolean', title: '模型开关' },
              },
            }}
            value={options}
            onChange={(next) => {
              specific.push(next)
              setOptions(next)
            }}
          />
        </div>
      )
    }
    const { user } = renderApp(<Harness />)

    const commonInput = screen.getByRole<HTMLInputElement>('spinbutton', { name: '语速' })
    const specificInput = screen.getByRole<HTMLInputElement>('spinbutton', {
      name: '模型专用语速',
    })
    expect(commonInput.id).not.toBe(specificInput.id)
    const describedBy = (input: HTMLInputElement) =>
      document.getElementById(input.getAttribute('aria-describedby')!)?.textContent
    expect(describedBy(commonInput)).toBe('通用倍率')
    expect(describedBy(specificInput)).toBe('模型专用倍率')

    typeNumber(commonInput, '1.2')
    commitNumber(commonInput)
    expect(common.at(-1)).toEqual({ speed: 1.2 })
    expect(specific).toHaveLength(0)
    expect(specificInput.value).toBe('0.5')

    typeNumber(specificInput, '0.8')
    commitNumber(specificInput)
    expect(specific.at(-1)).toEqual({ speed: 0.8 })
    expect(common.at(-1)).toEqual({ speed: 1.2 })
    expect(commonInput.value).toBe('1.2')

    await choose(user, '模型开关', '开')
    expect(specific.at(-1)).toEqual({ speed: 0.8, flag: true })
    expect(common.at(-1)).toEqual({ speed: 1.2 })
    expect(commonInput.value).toBe('1.2')
    expect(specificInput.value).toBe('0.8')
  })
})

describe('嵌套对象字段', () => {
  const schema: ObjectSchema = {
    properties: {
      svg: {
        type: 'object',
        title: 'SVG 作者设置',
        required: ['model'],
        properties: {
          model: { type: 'string', title: '模型' },
          reasoning: {
            type: 'object',
            title: '推理',
            properties: { effort: { type: 'string', title: '强度', enum: ['low', 'high'] } },
          },
        },
      },
    },
  }

  it('勾选启用后才写入，值存成对象而不是字符串，嵌套枚举照常渲染', async () => {
    const { submitted, user } = renderForm(schema)
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: /SVG 作者设置/ }))
    expect(submitted.at(-1)).toEqual({ svg: {} })
    expect(screen.getByText('缺少必填项：model')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: /模型/ }), {
      target: { value: 'gpt-x' },
    })
    expect(submitted.at(-1)).toEqual({ svg: { model: 'gpt-x' } })
    expect(screen.queryByText(/缺少必填项/)).toBeNull()

    await user.click(screen.getByRole('checkbox', { name: /推理/ }))
    await choose(user, '强度', 'high')
    expect(submitted.at(-1)).toEqual({ svg: { model: 'gpt-x', reasoning: { effort: 'high' } } })
  })

  it('空对象也是有效值（如联网搜索用默认设置），取消勾选才撤销', async () => {
    const { submitted, user } = renderForm(
      { properties: { web_search: { type: 'object', title: '联网搜索', properties: {} } } },
      { web_search: {} },
    )
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '联网搜索' }).checked).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: '联网搜索' }))
    expect(submitted.at(-1)).toEqual({})
  })

  it('枚举字符串数组渲染成多选，全部取消后撤销该参数', async () => {
    const { submitted, user } = renderForm({
      properties: {
        sources: {
          type: 'array',
          title: '搜索来源',
          items: { type: 'string', enum: ['douyin', 'doubao'] },
        },
      },
    })
    await user.click(screen.getByRole('checkbox', { name: 'douyin' }))
    await user.click(screen.getByRole('checkbox', { name: 'doubao' }))
    expect(submitted.at(-1)).toEqual({ sources: ['douyin', 'doubao'] })
    await user.click(screen.getByRole('checkbox', { name: 'douyin' }))
    await user.click(screen.getByRole('checkbox', { name: 'doubao' }))
    expect(submitted.at(-1)).toEqual({})
  })

  it('数组等没有控件的结构不渲染成文本框', () => {
    renderForm({
      properties: { tags: { type: 'array', title: '标签', items: { type: 'object' } } },
    })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('该参数暂不支持在界面中编辑')).toBeTruthy()
  })
})

describe('开区间与推导默认', () => {
  it('exclusiveMinimum：等于边界的输入作废并保留原值，说明文字写「大于」', () => {
    const { submitted } = renderForm(
      {
        properties: {
          weight: { type: 'number', title: '权重', exclusiveMinimum: 0, maximum: 1 },
        },
      },
      { weight: 0.5 },
    )
    expect(screen.getByText('大于 0，不大于 1')).toBeTruthy()
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '权重' })
    typeNumber(input, '0')
    commitNumber(input)
    expect(submitted).toHaveLength(0)
    expect(screen.getByRole('alert')).toBeTruthy()
    typeNumber(input, '0.2')
    commitNumber(input)
    expect(submitted.at(-1)).toEqual({ weight: 0.2 })
  })

  it('尺寸由画幅换算时不把声明里的 auto 当成当前值，占位提示跟随画幅', () => {
    const { submitted } = renderForm({
      properties: {
        size: {
          type: 'string',
          title: '输出尺寸',
          default: 'auto',
          'x-aspectRatioSizes': { '1:1': '1024x1024' },
        },
      },
    })
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '输出尺寸' })
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('跟随画幅')
    fireEvent.change(input, { target: { value: '1024x1024' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(submitted.at(-1)).toEqual({})
  })

  it('枚举（如视频输出格式）正常渲染并写回', async () => {
    const { submitted, user } = renderForm({
      properties: { output_format: { type: 'string', title: '输出格式', enum: ['mp4', 'mov'] } },
    })
    await choose(user, '输出格式', 'mov')
    expect(submitted.at(-1)).toEqual({ output_format: 'mov' })
  })
})
