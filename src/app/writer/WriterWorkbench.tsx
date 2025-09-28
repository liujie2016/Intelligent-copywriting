"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "sonner"
import { splitNumberedBlocks, stripThinking } from "@/lib/text"
import { chatCompletion, type ChatMessage } from "@/lib/openai"
import { readLS, writeLS, exportAll, importAll, type DefaultsState, type NoteApiConfig } from "@/lib/storage"
import type { ApiProfiles, ModelConfig, PromptItem, TaskInput, TaskResult, ImageItem } from "@/lib/types"
import Link from "next/link"

// 安全 ID 生成（兼容无 secure context 或早期环境）
function genId() {
  try {
    // @ts-ignore
    if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID()
  } catch {}
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={[
        "flex min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
        "ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        props.className || "",
      ].join(" ")}
    />
  )
}

// 复制工具：带降级方案
async function safeCopy(text: string) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      toast.success("已复制到剪贴板")
      return
    }
  } catch {}
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.left = "-9999px"
    document.body.appendChild(ta)
    ta.select()
    document.execCommand("copy")
    document.body.removeChild(ta)
    toast.success("已复制到剪贴板")
  } catch (e) {
    toast.error("复制失败：环境限制")
  }
}

// 默认存储读取
function usePersistentState<T>(key: string, fallback: T) {
  const [state, setState] = useState<T>(() => readLS<any>(key as any, fallback))
  useEffect(() => {
    writeLS<any>(key as any, state)
  }, [key, state])
  return [state, setState] as const
}

export const WriterWorkbench = () => {
  // 粘贴与拆分
  const [rawInput, setRawInput] = useState("")
  const [autoSplitByAI, setAutoSplitByAI] = useState(false) // 可选的AI拆分占位（未来可接入拆分模型）

  // 任务与结果持久化
  const [tasks, setTasks] = usePersistentState<TaskInput[]>("tasks", [])
  const [results, setResults] = usePersistentState<TaskResult[]>("results", [])
  const [images, setImages] = usePersistentState<ImageItem[]>("images", [])

  // 提示词管理
  const [prompts, setPrompts] = usePersistentState<PromptItem[]>("prompts", [])
  const [defaults, setDefaults] = usePersistentState<DefaultsState>("defaults", {})

  // API 配置：搜索与写作各自独立
  const [apiProfiles, setApiProfiles] = usePersistentState<Partial<ApiProfiles>>("apiProfiles", {
    search: undefined,
    write: undefined,
    split: undefined,
    image: undefined,
  })

  // 笔记 API 配置
  const [noteApi, setNoteApi] = usePersistentState<NoteApiConfig>("noteApi", {
    endpoint: "https://dinoai.chatgo.pro/openapi/text/input",
    apiKey: "",
  })

  // 新增：导入 JSON 的内联区域替代 prompt()
  const [showImportBox, setShowImportBox] = useState(false)
  const [importText, setImportText] = useState("")

  // 全局设置
  const [globalNeedsSearch, setGlobalNeedsSearch] = useState(false)
  const [globalGuidance, setGlobalGuidance] = useState("")
  const [globalPromptId, setGlobalPromptId] = useState<string | undefined>(undefined)
  // 新增：生成数量 & 自动保存
  const [writeCount, setWriteCount] = usePersistentState<number>("writeCount", 1)
  const [autoSaveNote, setAutoSaveNote] = usePersistentState<boolean>("autoSaveNote", false)

  // 运行状态
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [stages, setStages] = useState<Record<string, string>>({})
  const [refineNotes, setRefineNotes] = useState<Record<string, string>>({})
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set())
  const cleanedOnHydrate = useRef(false)

  // 在首次挂载时，对历史 results 做兜底清理，去除任何残留的思考/推理内容
  useEffect(() => {
    if (cleanedOnHydrate.current) return
    if (!Array.isArray(results) || results.length === 0) return
    const next = results.map((r) => ({
      ...r,
      searchOutput: r.searchOutput ? stripThinking(r.searchOutput) : r.searchOutput,
      writeOutput: r.writeOutput ? stripThinking(r.writeOutput) : r.writeOutput,
    }))
    // 仅当有变化时再写入，避免无意义的状态更新
    const changed = next.some((n, i) => n.searchOutput !== results[i].searchOutput || n.writeOutput !== results[i].writeOutput)
    if (changed) setResults(next)
    cleanedOnHydrate.current = true
  }, [])

  // 统计
  const selectedWritePrompt = useMemo(() => {
    const id = globalPromptId || (defaults as any).defaultWritePromptId
    return prompts.find((p) => p.id === id)
  }, [globalPromptId, (defaults as any).defaultWritePromptId, prompts])

  const selectedSearchPrompt = useMemo(() => {
    const id = (defaults as any).defaultSearchPromptId
    return prompts.find((p) => p.id === id)
  }, [(defaults as any).defaultSearchPromptId, prompts])

  const selectedSplitPrompt = useMemo(() => {
    const id = (defaults as any).defaultSplitPromptId
    return prompts.find((p) => p.id === id)
  }, [(defaults as any).defaultSplitPromptId, prompts])

  // 拆分为任务
  const handleSplit = async () => {
    let source = rawInput
    // 优先使用 AI 拆分（若启用且配置完整）
    if (autoSplitByAI) {
      try {
        if (!apiProfiles.split) throw new Error("未配置拆分 API")
        const sp = selectedSplitPrompt
        if (!sp) throw new Error("未设置默认拆分 Prompt，请在‘提示词管理’设置默认项")
        const msgs: ChatMessage[] = [
          { role: "system", content: sp.content },
          { role: "user", content: rawInput },
        ]
        const out = await chatCompletion({
          config: apiProfiles.split as ModelConfig,
          messages: msgs,
        })
        source = stripThinking(out || rawInput)
      } catch (e: any) {
        toast.error(`AI 拆分失败：${e?.message || e}，将使用本地规则尝试拆分`)
      }
    }

    const blocks = splitNumberedBlocks(source)
    if (!blocks.length) {
      toast.error("未检测到可拆分的内容")
      return
    }
    const newTasks: TaskInput[] = blocks.map((b, i) => ({
      id: genId(),
      index: i + 1,
      title: undefined,
      tags: [],
      promptKey: selectedWritePrompt?.id,
      guidance: "",
      needsSearch: globalNeedsSearch,
      raw: b.text,
    }))
    setTasks(newTasks)
    toast.success(`已拆分为 ${newTasks.length} 条`)
  }

  // 全局应用到所有任务
  const applyGlobalToAll = () => {
    setTasks((prev) =>
      prev.map((t) => ({
        ...t,
        needsSearch: globalNeedsSearch,
        guidance: globalGuidance || t.guidance,
        promptKey: globalPromptId ?? t.promptKey,
      }))
    )
    toast.success("已将全局设置应用到所有条目")
  }

  // 单条运行：搜索（可选）→ 写作
  const abortMap = useRef<Map<string, AbortController>>(new Map())

  const runOne = async (task: TaskInput) => {
    const id = task.id
    if (!apiProfiles.write) {
      toast.error("请先在设置中配置‘文案生成 API'！")
      return
    }

    const runIdSet = new Set(runningIds)
    runIdSet.add(id)
    setRunningIds(runIdSet)

    const ac = new AbortController()
    abortMap.current.set(id, ac)

    try {
      let searchOutput: string | undefined
      if (task.needsSearch) {
        if (!apiProfiles.search) {
          throw new Error("已勾选联网检索，但未配置‘搜索增强 API'")
        }
        const sp = selectedSearchPrompt
        if (!sp) throw new Error("未设置默认搜索 Prompt，请在‘提示词管理’设置默认项")

        setStages((prev) => ({ ...prev, [id]: "联网检索中" }))
        const msgs: ChatMessage[] = [
          { role: "system", content: sp.content },
          { role: "user", content: task.raw },
        ]
        searchOutput = await chatCompletion({
          config: apiProfiles.search as ModelConfig,
          messages: msgs,
          signal: ac.signal,
        })
        // 过滤检索阶段可能返回的思考/推理内容
        searchOutput = stripThinking(searchOutput)
      }

      const wp = task.promptKey ? prompts.find((p) => p.id === task.promptKey) : selectedWritePrompt
      if (!wp) throw new Error("未找到写作 Prompt，请在‘提示词管理’中设置或选择")

      // 串联：将搜索结果"原封不动"传递给写作模型（已做思考内容过滤）
      const userContent = task.needsSearch ? (searchOutput || "") : task.raw
      const composeUser = [
        userContent,
        task.guidance?.trim() ? `\n\n[指导重点]\n${task.guidance}` : "",
        globalGuidance?.trim() && task.guidance?.trim() ? "" : (globalGuidance?.trim() ? `\n\n[批量指导]\n${globalGuidance}` : ""),
      ].join("")

      setStages((prev) => ({ ...prev, [id]: "写作中" }))
      const writeMessages: ChatMessage[] = [
        { role: "system", content: wp.content },
        { role: "user", content: composeUser },
      ]

      const count = Math.max(1, Math.min(5, Number(writeCount) || 1))
      const createdIds: string[] = []

      if (count === 1) {
        let writeOutput = await chatCompletion({
          config: apiProfiles.write as ModelConfig,
          messages: writeMessages,
          signal: ac.signal,
        })
        writeOutput = stripThinking(writeOutput)
        const tr: TaskResult = {
          id: task.id,
          index: task.index,
          raw: task.raw,
          searchOutput,
          writeOutput,
          createdAt: Date.now(),
          // parentId: undefined  // 不设置，保持兼容
        } as any
        setResults((prev) => {
          const others = prev.filter((x) => x.id !== tr.id)
          return [...others, tr].sort((a, b) => a.index - b.index)
        })
        createdIds.push(tr.id)
      } else {
        // 并发生成多版本
        const ks = Array.from({ length: count }, (_, i) => i + 1)
        const variants: TaskResult[] = await Promise.all(
          ks.map(async (k) => {
            let out = await chatCompletion({
              config: apiProfiles.write as ModelConfig,
              messages: writeMessages,
              signal: ac.signal,
            })
            out = stripThinking(out)
            const vid = `${task.id}-${k}`
            return {
              id: vid,
              index: task.index,
              raw: task.raw,
              searchOutput,
              writeOutput: out,
              createdAt: Date.now(),
              parentId: task.id,
              variantNo: k,
            } as any
          })
        )
        setResults((prev) => {
          // 移除该任务旧的变体（含单版本）
          const others = prev.filter((x: any) => x.id !== task.id && x.parentId !== task.id)
          return [...others, ...variants].sort((a, b) => (a.index - b.index) || ((a as any).variantNo || 0) - ((b as any).variantNo || 0))
        })
        createdIds.push(...variants.map((v) => v.id))
      }

      // 自动保存到笔记（可选）
      if (autoSaveNote) {
        await saveToNoteApi(createdIds)
      }
    } catch (e: any) {
      toast.error(`条目 ${task.index} 处理失败：${e?.message || e}`)
    } finally {
      abortMap.current.delete(id)
      setRunningIds((prev) => {
        const ns = new Set(prev)
        ns.delete(id)
        return ns
      })
      setStages((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  // 并发运行所选（全部）
  const runAll = async () => {
    if (!tasks.length) {
      toast.error("没有可处理的条目")
      return
    }
    await Promise.all(tasks.map((t) => runOne(t)))
    toast.success("全部处理完成")
  }

  const stopAll = () => {
    abortMap.current.forEach((ac) => ac.abort())
    abortMap.current.clear()
    setRunningIds(new Set())
    toast.success("已尝试终止所有任务")
  }

  // 结果选择与批量操作工具
  const clean = (s?: string) => stripThinking(s || "").trim()
  const toggleSelect = (id: string) =>
    setSelectedResultIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const selectAll = (checked: boolean) => {
    if (!checked) { setSelectedResultIds(new Set()); return }
    setSelectedResultIds(new Set(results.map((r) => r.id)))
  }
  const copySelected = async () => {
    const ids = Array.from(selectedResultIds)
    if (!ids.length) { toast.error("请先选择要复制的文案"); return }
    const items = results.filter((r) => ids.includes(r.id)).sort((a,b)=>a.index-b.index)
    const text = items.map((r, i) => {
      const title = `文案${i + 1}`
      const body = clean(r.writeOutput)
      return body ? `${title}\n${"-".repeat(title.length)}\n${body}` : ""
    }).filter(Boolean).join("\n\n\n")
    if (!text) { toast.error("所选内容为空"); return }
    await safeCopy(text)
  }
  const deleteSelected = () => {
    const ids = new Set(selectedResultIds)
    if (!ids.size) { toast.error("请先选择要删除的文案"); return }
    setResults((prev) => prev.filter((r) => !ids.has(r.id)))
    setRefineNotes((prev) => {
      const next = { ...prev }
      ids.forEach((id) => { delete next[id] })
      return next
    })
    setSelectedResultIds(new Set())
    toast.success("已删除所选文案")
  }
  const clearAllResults = () => {
    if (!results.length) { toast.error("暂无可清空的结果"); return }
    setResults([])
    setSelectedResultIds(new Set())
    setRefineNotes({})
    toast.success("已清空全部结果")
  }
  useEffect(() => {
    // 结果变化时，清理无效选择
    setSelectedResultIds((prev) => new Set(Array.from(prev).filter((id) => results.some((r) => r.id === id))))
  }, [results])

  // 合并导出文本
  const combinedText = useMemo(() => {
    if (!results.length) return ""
    const lines: string[] = []
    const list = results.slice().sort((a: any, b: any) => (a.index - b.index) || ((a.variantNo || 0) - (b.variantNo || 0)))
    list.forEach((r: any, i: number) => {
      const base = `文案${r.index}`
      const suffix = r.parentId ? ` - 版本${r.variantNo}` : ""
      const title = `${base}${suffix}`
      const body = clean(r.writeOutput)
      if (body) {
        lines.push(`${title}\n${"-".repeat(title.length)}\n${body}`)
      }
    })
    return lines.join("\n\n\n")
  }, [results])

  const downloadTxt = () => {
    const blob = new Blob([combinedText], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `文案_${new Date().toISOString().slice(0, 10)}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const saveToNoteApi = async (selectedIds?: string[]) => {
    const endpoint = noteApi.endpoint
    const token = noteApi.apiKey
    if (!endpoint) { toast.error("请在设置中配置笔记 API 地址"); return }
    if (!token) { toast.error("请在设置中填写笔记 API Key"); return }

    const payloads = results
      .filter((r) => !selectedIds || selectedIds.includes(r.id))
      .map((r, i) => ({
        content: `文案${i + 1}\n\n${clean(r.writeOutput)}`,
      }))

    if (!payloads.length) { toast.error("没有可保存的内容"); return }

    try {
      await Promise.all(
        payloads.map((p) =>
          fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(p),
          })
        )
      )
      toast.success("已批量保存到笔记")
    } catch (e: any) {
      toast.error(`保存失败：${e?.message || e}`)
    }
  }

  const selectedWriteModels = useMemo(() => (apiProfiles.write ? [apiProfiles.write.model] : []), [apiProfiles.write])
  const selectedSearchModels = useMemo(() => (apiProfiles.search ? [apiProfiles.search.model] : []), [apiProfiles.search])

  // UI 渲染
  return (
    <main className="relative mx-auto max-w-6xl p-8 md:p-10 space-y-8 min-h-screen">
      <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">批量文案工作台</h1>
      <p className="text-sm text-muted-foreground -mt-4">粘贴素材 → 自动拆分 → 可选联网检索 → 并发生成文案 → 结果导出/保存</p>
      <div className="-mt-2">
        <Link href="/images" className="text-sm text-primary underline underline-offset-2">前往图像生成页</Link>
      </div>

      <Tabs defaultValue="process">
        <TabsList className="grid w-full grid-cols-3 rounded-xl bg-secondary/60 p-1 backdrop-blur ring-1 ring-white/30 shadow-sm">
          <TabsTrigger value="process">内容处理</TabsTrigger>
          <TabsTrigger value="results">结果查看</TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>

        <TabsContent value="process" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>粘贴原材料（支持编号自动拆分）</CardTitle>
              <CardDescription>将混杂内容粘贴到下方，可自动按 1. 2) 3） 等编号拆分为多条。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="在此粘贴内容，示例：\n1. 这是第一条\n2) 这是第二条\n3） 这是第三条"
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                className="min-h-[220px]"
              />
              <div className="flex flex-col md:flex-row md:items-center gap-4">
                <div className="flex items-center gap-2">
                  <input id="autoSplitAi" type="checkbox" checked={autoSplitByAI} onChange={(e) => setAutoSplitByAI(e.target.checked)} />
                  <Label htmlFor="autoSplitAi">启用AI拆分（使用“拆分 API + 拆分 Prompt”）</Label>
                </div>
                <div className="text-xs text-muted-foreground">
                  默认拆分 Prompt：{selectedSplitPrompt?.name || "未设置"}
                </div>
                <Button onClick={handleSplit}>拆分为条目</Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>全局设置</CardTitle>
              <CardDescription>这些设置可一键套用到下方所有条目，也可逐条修改。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex items-center gap-2">
                  <input id="gns" type="checkbox" checked={globalNeedsSearch} onChange={(e) => setGlobalNeedsSearch(e.target.checked)} />
                  <Label htmlFor="gns">全局启用联网检索</Label>
                </div>
                <div>
                  <Label>选择写作 Prompt</Label>
                  <Select value={globalPromptId} onValueChange={setGlobalPromptId}>
                    <SelectTrigger>
                      <SelectValue placeholder="不变/使用默认" />
                    </SelectTrigger>
                    <SelectContent>
                      {prompts
                        .filter((p) => p.category === "文案生成" || p.category === "自定义")
                        .map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>批量指导（可选）</Label>
                  <Input
                    placeholder="例如：突出干货与实用技巧"
                    value={globalGuidance}
                    onChange={(e) => setGlobalGuidance(e.target.value)}
                  />
                </div>
                <div>
                  <Label>每条生成数量</Label>
                  <Input type="number" min={1} max={5} value={writeCount}
                    onChange={(e) => setWriteCount(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} />
                  <p className="text-xs text-muted-foreground mt-1">设置为1即为单版本；{'&gt;'}1 将为每条自动生成多版本</p>
                </div>
              </div>
              <div className="flex gap-3">
                <Button variant="secondary" onClick={applyGlobalToAll}>应用到所有条目</Button>
                <Button onClick={runAll}>并发处理全部</Button>
                <Button variant="destructive" onClick={stopAll}>终止全部</Button>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>条目列表（可逐条修改设置与运行）</CardTitle>
              <CardDescription>写作模型：{selectedWriteModels.join(", ") || "未配置"}；检索模型：{selectedSearchModels.join(", ") || "未配置"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!tasks.length && <p className="text-muted-foreground">暂无条目，请先在上方粘贴并拆分。</p>}
              {Boolean(tasks.length) && (
                <div className="flex flex-wrap gap-3">
                  <Button size="sm" variant="destructive" onClick={() => {
                    if (!tasks.length) return
                    setTasks([])
                    toast.success("已清空条目列表")
                  }}>清空全部条目</Button>
                </div>
              )}
              <div className="space-y-4">
                {tasks.map((t) => {
                  const running = runningIds.has(t.id)
                  return (
                    <div key={t.id} className="rounded-md border p-4 space-y-3 bg-white/50 dark:bg-white/5 backdrop-blur-sm">
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">#{t.index}</span>
                          <input
                            id={`ns-${t.id}`}
                            type="checkbox"
                            checked={t.needsSearch}
                            onChange={(e) => setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, needsSearch: e.target.checked } : x)))}
                          />
                          <Label htmlFor={`ns-${t.id}`}>联网检索</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label>写作Prompt</Label>
                          <Select value={t.promptKey} onValueChange={(v) => setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, promptKey: v } : x)))}>
                            <SelectTrigger className="min-w-[220px]">
                              <SelectValue placeholder="使用默认" />
                            </SelectTrigger>
                            <SelectContent>
                              {prompts
                                .filter((p) => p.category === "文案生成" || p.category === "自定义")
                                .map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => {
                            setTasks((prev) => prev.filter((x) => x.id !== t.id))
                            toast.success("已删除该条条目")
                          }}>删除条目</Button>
                          <Button size="sm" variant="outline" onClick={() => {
                            setTasks((prev) => {
                              const cur = prev.find((x) => x.id === t.id)
                              return cur ? [{ ...cur, index: 1 }] : prev
                            })
                            toast.success("已仅保留此条")
                          }}>仅保留此条</Button>
                          <Button size="sm" onClick={() => runOne(t)} disabled={running}>{running ? "处理中..." : "只处理此条"}</Button>
                        </div>
                      </div>
                      {running && (
                        <div className="text-xs text-muted-foreground">
                          当前处理阶段：{stages[t.id] || (t.needsSearch ? "准备检索" : "准备写作")}
                        </div>
                      )}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <Label>原文（可编辑）</Label>
                          <Textarea
                            value={t.raw}
                            onChange={(e) => setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, raw: e.target.value } : x)))}
                            className="min-h-[120px]"
                          />
                        </div>
                        <div>
                          <Label>单条指导（可选）</Label>
                          <Textarea
                            placeholder="为该条目补充个性化指导"
                            value={t.guidance || ""}
                            onChange={(e) => setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, guidance: e.target.value } : x)))}
                            className="min-h-[120px]"
                          />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="results" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>结果查看与导出</CardTitle>
              <CardDescription>可单条复制、批量复制、下载 TXT，或通过 API 批量保存到笔记。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!results.length && <p className="text-muted-foreground">暂无结果。请先执行处理。</p>}
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => safeCopy(combinedText)} disabled={!results.length}>批量复制合并文本</Button>
                <Button onClick={downloadTxt} disabled={!results.length}>下载TXT</Button>
                <Button onClick={() => saveToNoteApi()} disabled={!results.length}>批量保存到笔记</Button>
              </div>
              {Boolean(results.length) && (
                <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 bg-white/40 dark:bg-white/5">
                  <div className="flex items-center gap-2">
                    <input
                      id="selectAllResults"
                      type="checkbox"
                      checked={results.length > 0 && selectedResultIds.size === results.length}
                      onChange={(e) => selectAll(e.target.checked)}
                    />
                    <Label htmlFor="selectAllResults">全选（{selectedResultIds.size}/{results.length}）</Label>
                  </div>
                  <Button size="sm" variant="secondary" onClick={copySelected} disabled={!selectedResultIds.size}>复制所选</Button>
                  <Button size="sm" variant="destructive" onClick={deleteSelected} disabled={!selectedResultIds.size}>删除所选</Button>
                  <Button size="sm" variant="destructive" onClick={clearAllResults}>清空全部</Button>
                </div>
              )}

              <div className="space-y-4 mt-4">
                {/* 分组展示：按 parentId 归并，同一条目多版本并列显示 */}
                {(() => {
                  const groups = new Map<string, TaskResult[] & any>()
                  results
                    .slice()
                    .sort((a: any, b: any) => (a.index - b.index) || ((a.variantNo || 0) - (b.variantNo || 0)))
                    .forEach((r: any) => {
                      const key = r.parentId || r.id
                      if (!groups.has(key)) groups.set(key, [] as any)
                      groups.get(key)!.push(r)
                    })
                  const entries = Array.from(groups.entries()).sort((a, b) => (a[1][0].index - b[1][0].index))
                  return entries.map(([gid, arr], gi) => (
                    <div key={gid} className="rounded-md border p-4 space-y-3 bg-white/50 dark:bg-white/5 backdrop-blur-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium">条目 #{arr[0].index} {arr.length > 1 ? <span className="text-xs text-muted-foreground">（{arr.length} 个版本）</span> : null}</div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {arr.map((r: any, i: number) => (
                          <div key={r.id} className="rounded-md border p-3 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <input
                                  id={`sel-${r.id}`}
                                  type="checkbox"
                                  checked={selectedResultIds.has(r.id)}
                                  onChange={() => toggleSelect(r.id)}
                                />
                                <Label htmlFor={`sel-${r.id}`} className="font-medium">{arr.length > 1 ? `版本 ${r.variantNo}` : `文案${r.index}`}</Label>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button size="sm" variant="ghost" onClick={() => {
                                  setResults((prev) => prev.filter((x) => x.id !== r.id))
                                  setSelectedResultIds((prev) => { const n = new Set(prev); n.delete(r.id); return n })
                                  setRefineNotes((prev) => { const n = { ...prev }; delete n[r.id]; return n })
                                  toast.success("已删除该条文案")
                                }}>删除</Button>
                                <Button size="sm" variant="secondary" onClick={() => safeCopy(clean((r as any).writeOutput))}>复制正文</Button>
                                <Button size="sm" onClick={() => saveToNoteApi([r.id])}>保存到笔记</Button>
                                <Link
                                  href={`/images?text=${encodeURIComponent(clean((r as any).writeOutput || ""))}&resultId=${encodeURIComponent(r.id)}`}
                                  className="inline-flex"
                                >
                                  <Button size="sm" variant="outline">去生成封面图</Button>
                                </Link>
                              </div>
                            </div>
                            {r.searchOutput && (
                              <details className="text-xs text-muted-foreground">
                                <summary className="cursor-pointer">检索结果（传递给写作）</summary>
                                <pre className="whitespace-pre-wrap mt-2">{stripThinking(r.searchOutput)}</pre>
                              </details>
                            )}
                            <div className="text-sm"><pre className="whitespace-pre-wrap">{clean((r as any).writeOutput)}</pre></div>
                            <div className="space-y-2">
                              <Label>对本条进行微调（追加指令）</Label>
                              <Textarea
                                placeholder="填写你的追加要求，如：更口语化、加上表情、保留要点但压缩到150字以内"
                                value={refineNotes[r.id] || ""}
                                onChange={(e) => setRefineNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                                className="min-h-[80px]"
                              />
                              <div className="flex items-center gap-2">
                                <Button size="sm" onClick={async () => {
                                  const note = (refineNotes[r.id] || "").trim()
                                  if (!note) { toast.error("请先填写追加指令"); return }
                                  // 兼容多版本：优先用 parentId 查找对应任务
                                  const task = tasks.find((t) => t.id === (r as any).parentId) || tasks.find((t) => t.id === r.id)
                                  if (!task) { toast.error("未找到对应条目，无法微调"); return }
                                  if (!apiProfiles.write) { toast.error("请先配置文案生成 API"); return }
                                  const wp = task.promptKey ? prompts.find((p) => p.id === task.promptKey) : selectedWritePrompt
                                  if (!wp) { toast.error("未找到写作 Prompt"); return }
                                  setStages((prev) => ({ ...prev, [r.id]: "微调中" }))
                                  try {
                                    const messages: ChatMessage[] = [
                                      { role: "system", content: wp.content },
                                      { role: "user", content: [
                                        `【原始素材】\n${task.raw}`,
                                        `\n\n【当前文案】\n${(r as any).writeOutput || ""}`,
                                        `\n\n【修改指令】\n${note}`,
                                        "\n\n【要求】直接输出最终文案，不要包含任何思考、解释或额外说明。"
                                      ].join("") },
                                    ]
                                    let newOut = await chatCompletion({
                                      config: apiProfiles.write as ModelConfig,
                                      messages,
                                      signal: undefined,
                                    })
                                    newOut = stripThinking(newOut)
                                    setResults((prev) => prev.map((x: any) => x.id === r.id ? { ...x, writeOutput: newOut, createdAt: Date.now() } : x))
                                    toast.success("已完成微调")
                                  } catch (e: any) {
                                    toast.error(`微调失败：${e?.message || e}`)
                                  } finally {
                                    setStages((prev) => { const next = { ...prev }; delete next[r.id]; return next })
                                  }
                                }}>
                                  {stages[r.id] === "微调中" ? "微调中..." : "基于此继续微调"}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </CardContent>
          </Card>

          {/* 新增：图片展示区 */}
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>生成的图片</CardTitle>
              <CardDescription>从"图像生成"页面创建的图片会展示在此处，便于与文案结果一并查看。</CardDescription>
            </CardHeader>
            <CardContent>
              {!images.length && <p className="text-muted-foreground">暂无图片。可在右上方链接进入"图像生成"页。</p>}
              {!!images.length && (
                <ImageGalleryPanel images={images} setImages={setImages} />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>API 配置（OpenAI 兼容）</CardTitle>
              <CardDescription>分别为"搜索增强模型"、"文案生成模型"、"拆分模型"和"图像生成模型"设置 API Endpoint、Key 和模型名。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-3">
                  <div className="text-sm font-medium">搜索增强 API</div>
                  <Input placeholder="Base URL，如 https://api.openai.com" value={apiProfiles.search?.baseUrl || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, search: { ...(p.search || { name: "search" } as any), baseUrl: e.target.value } as any }))} />
                  <Input placeholder="API Key" value={apiProfiles.search?.apiKey || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, search: { ...(p.search || { name: "search" } as any), apiKey: e.target.value } as any }))} />
                  <Input placeholder="模型名，如 gpt-4o-mini" value={apiProfiles.search?.model || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, search: { ...(p.search || { name: "search" } as any), model: e.target.value } as any }))} />
                </div>
                <div className="space-y-3">
                  <div className="text-sm font-medium">文案生成 API</div>
                  <Input placeholder="Base URL" value={apiProfiles.write?.baseUrl || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, write: { ...(p.write || { name: "write" } as any), baseUrl: e.target.value } as any }))} />
                  <Input placeholder="API Key" value={apiProfiles.write?.apiKey || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, write: { ...(p.write || { name: "write" } as any), apiKey: e.target.value } as any }))} />
                  <Input placeholder="模型名" value={apiProfiles.write?.model || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, write: { ...(p.write || { name: "write" } as any), model: e.target.value } as any }))} />
                  <div className="flex items-center gap-2">
                    <input id="tf" type="checkbox" checked={Boolean(apiProfiles.write?.thinkingFilter)} onChange={(e) => setApiProfiles((p) => ({ ...p, write: { ...(p.write || { name: "write" } as any), thinkingFilter: e.target.checked } as any }))} />
                    <Label htmlFor="tf">过滤包含 thinking 的推理过程（仅对文案生成模型）</Label>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="text-sm font-medium">拆分 API</div>
                  <Input placeholder="Base URL" value={apiProfiles.split?.baseUrl || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, split: { ...(p.split || { name: "split" } as any), baseUrl: e.target.value } as any }))} />
                  <Input placeholder="API Key" value={apiProfiles.split?.apiKey || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, split: { ...(p.split || { name: "split" } as any), apiKey: e.target.value } as any }))} />
                  <Input placeholder="模型名" value={apiProfiles.split?.model || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, split: { ...(p.split || { name: "split" } as any), model: e.target.value } as any }))} />
                </div>
                <div className="space-y-3">
                  <div className="text-sm font-medium">图像生成 API</div>
                  <Input placeholder="Base URL" value={apiProfiles.image?.baseUrl || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), baseUrl: e.target.value } as any }))} />
                  <Input placeholder="API Key" value={apiProfiles.image?.apiKey || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), apiKey: e.target.value } as any }))} />
                  <Input placeholder="模型名" value={apiProfiles.image?.model || ""} onChange={(e) => setApiProfiles((p) => ({ ...p, image: { ...(p.image || { name: "image" } as any), model: e.target.value } as any }))} />
                </div>
              </div>
              <div className="space-y-3">
                <div className="text-sm font-medium">笔记 API</div>
                <Input placeholder="Endpoint，如 https://dinoai.chatgo.pro/openapi/text/input" value={noteApi.endpoint} onChange={(e) => setNoteApi({ ...noteApi, endpoint: e.target.value })} />
                <Input placeholder="Authorization（API Key）" value={noteApi.apiKey} onChange={(e) => setNoteApi({ ...noteApi, apiKey: e.target.value })} />
                <div className="flex items-center gap-2">
                  <input id="autoSaveNote" type="checkbox" checked={autoSaveNote} onChange={(e) => setAutoSaveNote(e.target.checked)} />
                  <Label htmlFor="autoSaveNote">文案生成完成后自动保存到笔记</Label>
                </div>
                <p className="text-xs text-muted-foreground -mt-1">开启后，每条文案生成完毕将立即通过上方 API 自动保存，无需手动点击。</p>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>提示词管理</CardTitle>
              <CardDescription>统一在此管理。取消 API 配置中的 Prompt 字段，避免歧义。可设置默认：搜索增强 / 文案生成 / 拆分。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <PromptManager
                prompts={prompts}
                onChange={(next) => setPrompts(next)}
                defaults={defaults}
                onDefaultsChange={setDefaults}
              />
            </CardContent>
          </Card>

          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>数据导入 / 导出</CardTitle>
              <CardDescription>导出所有配置与数据（API、提示词、默认项、笔记API、任务、结果、图片），便于迁移与备份。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => safeCopy(exportAll())}>复制导出JSON</Button>
                <Button onClick={() => {
                  const blob = new Blob([exportAll()], { type: "application/json;charset=utf-8" })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement("a")
                  a.href = url
                  a.download = `writer_data_${new Date().toISOString().slice(0,10)}.json`
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                }}>下载JSON文件</Button>
                <Button onClick={() => setShowImportBox((v) => !v)}>{showImportBox ? "收起导入" : "导入JSON（粘贴）"}</Button>
                <label className="inline-flex">
                  <input type="file" accept="application/json" className="hidden" onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (!f) return
                    const reader = new FileReader()
                    reader.onload = () => {
                      try { importAll(String(reader.result || "")); toast.success("文件导入成功，刷新后生效") } catch (err: any) { toast.error(`导入失败：${err?.message || err}`) }
                    }
                    reader.readAsText(f)
                    e.currentTarget.value = ""
                  }} />
                  <span className="px-3 py-2 rounded-md border bg-white/50 dark:bg-white/5 cursor-pointer select-none">从文件导入</span>
                </label>
              </div>
              {showImportBox && (
                <div className="mt-3 space-y-3 rounded-md border p-3 bg-white/50 dark:bg-white/5">
                  <Label>在此粘贴导出的 JSON 配置</Label>
                  <Textarea
                    placeholder="粘贴导出的 JSON 内容"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className="min-h-[160px]"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => {
                        if (!importText.trim()) { toast.error("请先粘贴 JSON"); return }
                        try {
                          importAll(importText)
                          toast.success("导入成功，刷新页面后生效")
                          setShowImportBox(false)
                          setImportText("")
                        } catch (e: any) {
                          toast.error(`导入失败：${e?.message || e}`)
                        }
                      }}
                    >
                      确认导入
                    </Button>
                    <Button variant="secondary" onClick={() => { setShowImportBox(false); setImportText("") }}>取消</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  )
}

// 提示词管理组件
function PromptManager({ prompts, onChange, defaults, onDefaultsChange }: {
  prompts: PromptItem[]
  onChange: (p: PromptItem[]) => void
  defaults: DefaultsState
  onDefaultsChange: (d: DefaultsState) => void
}) {
  const [name, setName] = useState("")
  const [category, setCategory] = useState("文案生成")
  const [content, setContent] = useState("")

  const addPrompt = () => {
    if (!name.trim() || !content.trim()) { toast.error("名称与内容均不能为空"); return }
    const item: PromptItem = { id: genId(), name: name.trim(), category, content }
    onChange([item, ...prompts])
    setName("")
    setContent("")
    toast.success("已添加提示词")
  }
  const removePrompt = (id: string) => onChange(prompts.filter((p) => p.id !== id))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div>
          <Label>名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：小红书风格" />
        </div>
        <div>
          <Label>分类</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="搜索增强">搜索增强</SelectItem>
              <SelectItem value="文案生成">文案生成</SelectItem>
              <SelectItem value="拆分">拆分</SelectItem>
              <SelectItem value="图像生成">图像生成</SelectItem>
              <SelectItem value="自定义">自定义</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <Label>内容</Label>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="在此粘贴你的提示词" />
        </div>
      </div>
      <Button onClick={addPrompt}>添加提示词</Button>

      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">已保存的提示词（点击设为默认，搜索/写作各一项）</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {prompts.map((p) => (
            <div key={p.id} className="border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-medium">{p.name} <span className="text-xs text-muted-foreground">[{p.category}]</span></div>
                <div className="flex items-center gap-2">
                  {p.category === "搜索增强" && (
                    <Button size="sm" variant={(defaults as any).defaultSearchPromptId === p.id ? "default" : "secondary"} onClick={() => onDefaultsChange({ ...(defaults as any), defaultSearchPromptId: p.id })}>
                      设为默认搜索
                    </Button>
                  )}
                  {(p.category === "文案生成" || p.category === "自定义") && (
                    <Button size="sm" variant={(defaults as any).defaultWritePromptId === p.id ? "default" : "secondary"} onClick={() => onDefaultsChange({ ...(defaults as any), defaultWritePromptId: p.id })}>
                      设为默认写作
                    </Button>
                  )}
                  {p.category === "拆分" && (
                    <Button size="sm" variant={(defaults as any).defaultSplitPromptId === p.id ? "default" : "secondary"} onClick={() => onDefaultsChange({ ...(defaults as any), defaultSplitPromptId: p.id })}>
                      设为默认拆分
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" onClick={() => removePrompt(p.id)}>删除</Button>
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-sm text-muted-foreground">查看内容</summary>
                <pre className="whitespace-pre-wrap text-sm mt-2">{p.content}</pre>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// 新增：结果页图片多选与批量操作面板
function ImageGalleryPanel({ images, setImages }: { images: ImageItem[]; setImages: React.Dispatch<React.SetStateAction<ImageItem[]>> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const allIds = images.map((i) => i.id)
  const allSelected = selected.size > 0 && selected.size === allIds.length

  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectAll = (on: boolean) => setSelected(on ? new Set(allIds) : new Set())

  const downloadOne = async (url: string) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `image_${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(a.href)
    } catch {
      // 回退：直接触发浏览器下载
      const a = document.createElement("a")
      a.href = url
      a.download = `image_${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
  }
  const downloadSelected = async () => {
    if (!selected.size) return
    const list = images.filter((i) => selected.has(i.id))
    for (const it of list) {
      await downloadOne(it.url)
    }
  }
  const deleteSelected = () => {
    if (!selected.size) return
    setImages((prev) => prev.filter((i) => !selected.has(i.id)))
    setSelected(new Set())
    toast.success("已删除所选图片")
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 bg-white/40 dark:bg-white/5">
        <div className="flex items-center gap-2">
          <input id="imgSelectAll" type="checkbox" checked={allSelected} onChange={(e) => selectAll(e.target.checked)} />
          <Label htmlFor="imgSelectAll">全选（{selected.size}/{images.length}）</Label>
        </div>
        <Button size="sm" variant="secondary" onClick={downloadSelected} disabled={!selected.size}>批量下载</Button>
        <Button size="sm" variant="destructive" onClick={deleteSelected} disabled={!selected.size}>批量删除</Button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {images
          .slice()
          .sort((a,b)=>b.createdAt - a.createdAt)
          .map((img) => (
            <div key={img.id} className="border rounded-md overflow-hidden bg-white/50 dark:bg-white/5">
              <img
                src={img.url}
                alt={img.prompt.slice(0,50)}
                className="w-full aspect-square object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none" }}
              />
              <div className="p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs line-clamp-2" title={img.prompt}>{img.prompt}</div>
                  <input type="checkbox" checked={selected.has(img.id)} onChange={() => toggle(img.id)} />
                </div>
                <a href={img.url} target="_blank" rel="noreferrer" className="block text-[11px] text-blue-600 underline break-all line-clamp-2">{img.url}</a>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => downloadOne(img.url)}>下载</Button>
                  <Button size="sm" variant="secondary" onClick={() => safeCopy(img.url)}>复制链接</Button>
                  <Button size="sm" variant="destructive" onClick={() => setImages(prev => prev.filter(x => x.id !== img.id))}>删除</Button>
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}