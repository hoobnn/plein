/**
 * 按所选模型处理节点参数的逻辑已下沉到 @plein/capabilities（服务端的 set_node_model 与界面共用同一份），
 * 这里只保留原有的导入路径。
 */
export {
  adaptToModel,
  constrainFields,
  modelProblem,
  selectedModel,
  type SelectedModel,
} from '@plein/capabilities'
