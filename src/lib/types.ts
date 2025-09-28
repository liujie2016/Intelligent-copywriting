export type ModelConfig = {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  thinkingFilter?: boolean // only for writing model
}

export type ApiProfiles = {
  search: ModelConfig
  write: ModelConfig
  // 新增：可选的拆分与图像生成模型配置
  split?: ModelConfig
  image?: ModelConfig
}

export type PromptItem = {
  id: string
  name: string
  category: string // e.g., "搜索增强", "文案生成", "拆分", or custom
  content: string
  isDefault?: boolean
}

export type TaskInput = {
  id: string
  index: number
  title?: string
  tags?: string[]
  promptKey?: string // optional: name/id of prompt to use for this item
  guidance?: string // per-item extra guidance
  needsSearch: boolean
  raw: string
}

export type TaskResult = {
  id: string
  index: number
  raw: string
  searchOutput?: string
  writeOutput?: string
  createdAt: number
}

// 新增：图像生成的本地存储结构
export type ImageItem = {
  id: string
  prompt: string
  url: string // data URL 或远程 URL
  linkedResultId?: string // 可选：关联某条文案结果
  createdAt: number
}

// 新增：默认项扩展（设置默认拆分提示词）
export type DefaultsState = {
  defaultSearchPromptId?: string
  defaultWritePromptId?: string
  defaultSplitPromptId?: string
}