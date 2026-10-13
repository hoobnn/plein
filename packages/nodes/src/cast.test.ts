import { describe, expect, it } from 'vite-plus/test'
import { parseCast, speakerTraits } from './cast'

describe('解析角色与场景抽取结果', () => {
  it('按二级标题分类，每个三级标题一张卡，空字段不写', () => {
    const md = `## 角色
### 林晚
- 外貌与年龄：二十岁，短发
- 服装：白衬衫
- 性格：
- 辨识特征：左眉有一道疤

### **老周**
- 外貌与年龄：五十多岁

## 场景
### 老城区天台
- 时间与地点：雨夜
- 光线与氛围：霓虹反光`
    expect(parseCast(md)).toEqual([
      {
        kind: 'character',
        name: '林晚',
        description: '外貌与年龄：二十岁，短发\n服装：白衬衫\n辨识特征：左眉有一道疤',
      },
      { kind: 'character', name: '老周', description: '外貌与年龄：五十多岁' },
      { kind: 'scene', name: '老城区天台', description: '时间与地点：雨夜\n光线与氛围：霓虹反光' },
    ])
  })

  it('LLM 原样抄回提示词模板时不产生卡片', () => {
    const template = `## 角色
### 角色名
- 外貌与年龄：
- 辨识特征：（出图时用它保持同一个人）

## 场景
### 场景名
- 时间与地点：`
    expect(parseCast(template)).toEqual([])
  })

  it('不认识的二级标题下的条目忽略；道具单独归类', () => {
    const md = `## 备注
### 随便写写
- 内容：无关

## 道具
### 铁盒
- 材质：生锈的铁皮`
    expect(parseCast(md)).toEqual([{ kind: 'prop', name: '铁盒', description: '材质：生锈的铁皮' }])
  })
})

describe('从设定看出配音的性别和年龄', () => {
  it('先认性别字段，没有再按称谓猜，猜不出留空', () => {
    expect(speakerTraits('林晚', '性别：女\n外貌与年龄：二十岁')).toEqual({
      gender: 'female',
      age: 'young',
    })
    expect(speakerTraits('黑衣男', '外貌与年龄：三十岁')).toEqual({ gender: 'male', age: 'young' })
    expect(speakerTraits('老周', '性别：男\n外貌与年龄：五十多岁')).toEqual({
      gender: 'male',
      age: 'mature',
    })
    expect(speakerTraits('阿九', '外貌与年龄：看不出年纪').gender).toBeUndefined()
  })
})
