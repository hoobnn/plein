/**
 * E1 对照实验的 6 个镜头（见 docs/plan/e1-3d-composition.md）：每个镜头一份 3D 构图场景和一段文字提示词。
 * A 组只用 prompt；B 组用同一段 prompt，前面加 B_PREFIX，并连上构图截图作参考图 1。
 * 场景坐标：米；机位默认在 +z 看向原点，画面右边是 +x；人物 facing 0 朝向镜头。
 */

/** 两个人物的外观，两组提示词里一字不差 */
const LIN = '林夏（二十多岁的女性，黑色齐肩短发，白衬衫，深灰长裤）'
const CHEN = '陈默（三十岁左右的男性，平头，深绿色夹克，牛仔裤）'
const STYLE = '写实电影剧照，自然光，35 毫米胶片质感，画面里没有文字。'

export const B_PREFIX =
  '按参考图 1 的构图、机位和人物站位来画；参考图是灰色人偶摆的构图草图，只取空间关系、景别和姿态，不要灰模质感。'

const lin = { name: '林夏', color: '#e08a7a', height: 1.65 }
const chen = { name: '陈默', color: '#7aa2ff', height: 1.78 }

export interface E1Shot {
  id: number
  title: string
  aspect: '16:9' | '9:16'
  prompt: string
  scene: Record<string, unknown>
}

export const E1_SHOTS: E1Shot[] = [
  {
    id: 1,
    title: '两人对峙',
    aspect: '16:9',
    prompt: `中景，机位平视，与人物胸口同高。空旷的仓库里，${LIN}站在画面左侧，${CHEN}站在画面右侧，两人面对面侧身对峙，相隔约两米，都只露出膝盖以上。${STYLE}`,
    scene: {
      aspect: '16:9',
      figures: [
        { id: 'a', ...lin, x: -0.85, z: 0, facing: 90, pose: 'stand' },
        { id: 'b', ...chen, x: 0.85, z: 0, facing: -90, pose: 'stand' },
      ],
      blocks: [],
      camera: { x: 0, y: 1.35, z: 3.8, tx: 0, ty: 1.1, tz: 0, focal: 40 },
    },
  },
  {
    id: 2,
    title: '过肩',
    aspect: '16:9',
    prompt: `过肩镜头。前景是${CHEN}的背影，后脑和肩膀占画面左侧三分之一，略虚；${LIN}在画面右侧中景，正对镜头看着他。咖啡馆室内。${STYLE}`,
    scene: {
      aspect: '16:9',
      figures: [
        { id: 'a', ...chen, x: -0.5, z: 1.9, facing: 180, pose: 'stand' },
        { id: 'b', ...lin, x: 0.35, z: 0, facing: -8, pose: 'stand' },
      ],
      blocks: [],
      camera: { x: -0.15, y: 1.6, z: 3.4, tx: 0.25, ty: 1.4, tz: 0, focal: 45 },
    },
  },
  {
    id: 3,
    title: '低机位仰拍',
    aspect: '16:9',
    prompt: `低机位仰拍，镜头贴近地面向上拍。天台上，${CHEN}站在画面中间，全身入画，伸直右臂指向画面左侧画外，头也转向那边；背景大部分是天空。${STYLE}`,
    scene: {
      aspect: '16:9',
      figures: [{ id: 'a', ...chen, x: 0, z: 0, facing: -55, pose: 'point' }],
      blocks: [],
      camera: { x: 0, y: 0.2, z: 3.2, tx: 0, ty: 1.45, tz: 0, focal: 18 },
    },
  },
  {
    id: 4,
    title: '一坐一站隔桌',
    aspect: '16:9',
    prompt: `中景，机位略高于桌面。办公室里一张长桌横在画面中间，${LIN}坐在桌子后面正对镜头，桌面挡住她腰部以下；${CHEN}站在桌子前方画面右侧，侧对镜头看着她，两人被桌子隔开。${STYLE}`,
    scene: {
      aspect: '16:9',
      figures: [
        { id: 'a', ...lin, x: 0, z: -0.65, facing: 0, pose: 'sit' },
        { id: 'b', ...chen, x: 1.15, z: 0.75, facing: -125, pose: 'stand' },
      ],
      blocks: [
        { id: 't', kind: 'box', name: '桌子', x: 0, z: 0, facing: 0, w: 1.8, h: 0.78, d: 0.8 },
        { id: 'c', kind: 'chair', x: 0, z: -0.75, facing: 0, w: 0.5, h: 0.9, d: 0.5 },
      ],
      camera: { x: -0.3, y: 1.45, z: 4.4, tx: 0.35, ty: 0.95, tz: 0, focal: 35 },
    },
  },
  {
    id: 5,
    title: '远景门边',
    aspect: '16:9',
    prompt: `远景，人物在画面里很小。老街上一堵长长的砖墙占据画面右半边，墙上有一扇木门；${LIN}站在门的左边，正面朝向镜头。画面左半边是街道和远处的空地。${STYLE}`,
    scene: {
      aspect: '16:9',
      figures: [{ id: 'a', ...lin, x: 0.25, z: 0.45, facing: 0, pose: 'stand' }],
      blocks: [
        { id: 'w', kind: 'wall', x: 4.3, z: 0, facing: 0, w: 7.5, h: 3.2, d: 0.25 },
        { id: 'd', kind: 'door', x: 1.3, z: 0.16, facing: 0, w: 1, h: 2.1, d: 0.1 },
      ],
      camera: { x: 0, y: 1.6, z: 12, tx: 0.6, ty: 1.3, tz: 0, focal: 30 },
    },
  },
  {
    id: 6,
    title: '竖画幅跪地伸手',
    aspect: '9:16',
    prompt: `竖画幅全景，机位平视略高。雨后的小巷，${LIN}单膝跪在画面左下方，抬头望向右侧；${CHEN}站在画面右侧，弯腰向她伸出右手。两人全身都在画面里。${STYLE}`,
    scene: {
      aspect: '9:16',
      figures: [
        { id: 'a', ...lin, x: -0.35, z: 0.1, facing: 55, pose: 'kneel' },
        // 「伸手」姿态是向上够，这里要向前递手给跪着的人，用平伸手臂的「指向」
        { id: 'b', ...chen, x: 0.45, z: -0.05, facing: -105, pose: 'point' },
      ],
      blocks: [],
      camera: { x: 0, y: 1.3, z: 2.8, tx: 0.05, ty: 0.95, tz: 0, focal: 30 },
    },
  },
]
