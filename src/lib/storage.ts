// 简单的 localStorage 持久化封装（提示词、API 配置、任务与结果、导入导出）
export type PersistKey =
  | "prompts"
  | "apiProfiles"
  | "defaults"
  | "tasks"
  | "results"
  | "noteApi"
  | "images"
  | "writeCount"
  | "autoSaveNote"
  | "imageCount"

export type DefaultsState = {
  defaultSearchPromptId?: string
  defaultWritePromptId?: string
  defaultSplitPromptId?: string
}

export type NoteApiConfig = {
  endpoint: string // e.g. https://dinoai.chatgo.pro/openapi/text/input
  apiKey: string
}

function safeParse<T>(raw: string | null, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function readLS<T>(key: PersistKey, fallback: T): T {
  if (typeof window === "undefined") return fallback
  return safeParse<T>(localStorage.getItem(key), fallback)
}

export function writeLS<T>(key: PersistKey, value: T) {
  if (typeof window === "undefined") return
  localStorage.setItem(key, JSON.stringify(value))
}

export function exportAll(): string {
  if (typeof window === "undefined") return "{}"
  const bundle = {
    prompts: readLS("prompts", []),
    apiProfiles: readLS("apiProfiles", { search: null, write: null, split: null, image: null } as any),
    defaults: readLS<DefaultsState>("defaults", {}),
    noteApi: readLS<NoteApiConfig>("noteApi", { endpoint: "https://dinoai.chatgo.pro/openapi/text/input", apiKey: "" }),
    tasks: readLS("tasks", []),
    results: readLS("results", []),
    images: readLS("images", []),
    writeCount: readLS("writeCount", 1),
    autoSaveNote: readLS("autoSaveNote", false),
    imageCount: readLS("imageCount", 1),
  }
  return JSON.stringify(bundle, null, 2)
}

export function importAll(json: string) {
  const data = safeParse<any>(json, {})
  if (data.prompts) writeLS("prompts", data.prompts)
  if (data.apiProfiles) writeLS("apiProfiles", data.apiProfiles)
  if (data.defaults) writeLS("defaults", data.defaults)
  if (data.noteApi) writeLS("noteApi", data.noteApi)
  if (data.tasks) writeLS("tasks", data.tasks)
  if (data.results) writeLS("results", data.results)
  if (data.images) writeLS("images", data.images)
  if (typeof data.writeCount !== "undefined") writeLS("writeCount", data.writeCount)
  if (typeof data.autoSaveNote !== "undefined") writeLS("autoSaveNote", data.autoSaveNote)
  if (typeof data.imageCount !== "undefined") writeLS("imageCount", data.imageCount)
}