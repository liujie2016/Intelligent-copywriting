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
import type { ApiProfiles, ModelConfig, PromptItem, TaskInput, TaskResult } from "@/lib/types"

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

export default function WriterWorkbench() {
  // 粘贴与拆分
  const [rawInput, setRawInput] = useState("")
  const [autoSplitByAI, setAutoSplitByAI] = useState(false) // 可选的AI拆分占位（未来可接入拆分模型）

  // 任务与结果持久化
  const [tasks, setTasks] = usePersistentState<TaskInput[]>("tasks", [])
  const [results, setResults] = usePersistentState<TaskResult[]>("results", [])

  // 提示词管理
  const [prompts, setPrompts] = usePersistentState<PromptItem[]>("prompts", [])
  const [defaults, setDefaults] = usePersistentState<DefaultsState>("defaults", {})

  // API 配置：搜索与写作各自独立
  const [apiProfiles, setApiProfiles] = usePersistentState<Partial<ApiProfiles>>("apiProfiles", {
    search: undefined,
    write: undefined,
  })

  // 笔记 API 配置
  const [noteApi, setNoteApi] = usePersistentState<NoteApiConfig>("noteApi", {
    endpoint: "https://dinoai.chatgo.pro/openapi/text/input",
    apiKey: "",
  })

  // 全局设置
  const [globalNeedsSearch, setGlobalNeedsSearch] = useState(false)
  const [globalGuidance, setGlobalGuidance] = useState("")
  const [globalPromptId, setGlobalPromptId] = useState<string | undefined>(undefined)

  // 运行状态
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [stages, setStages] = useState<Record<string, string>>({})
  const [refineNotes, setRefineNotes] = useState<Record<string, string>>({})

  // 统计
  const selectedWritePrompt = useMemo(() => {
    const id = globalPromptId || defaults.defaultWritePromptId
    return prompts.find((p) => p.id === id)
  }, [globalPromptId, defaults.defaultWritePromptId, prompts])

  const selectedSearchPrompt = useMemo(() => {
    const id = defaults.defaultSearchPromptId
    return prompts.find((p) => p.id === id)
  }, [defaults.defaultSearchPromptId, prompts])

  // 拆分为任务
  const handleSplit = () => {
    const blocks = splitNumberedBlocks(rawInput)
    if (!blocks.length) {
      toast.error("未检测到可拆分的内容")
      return
    }
    const newTasks: TaskInput[] = blocks.map((b, i) => ({
      id: crypto.randomUUID(),
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

      let writeOutput = await chatCompletion({
        config: apiProfiles.write as ModelConfig,
        messages: writeMessages,
        signal: ac.signal,
      })

      // 始终过滤服务商返回的思考/推理内容，确保只保留纯净正文
      writeOutput = stripThinking(writeOutput)

      const tr: TaskResult = {
        id: task.id,
        index: task.index,
        raw: task.raw,
        searchOutput,
        writeOutput,
        createdAt: Date.now(),
      }
      setResults((prev) => {
        const others = prev.filter((x) => x.id !== tr.id)
        return [...others, tr].sort((a, b) => a.index - b.index)
      })
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

  // 合并导出文本
  const combinedText = useMemo(() => {
    if (!results.length) return ""
    const lines: string[] = []
    results
      .sort((a, b) => a.index - b.index)
      .forEach((r, i) => {
        const title = `文案${i + 1}`
        const body = (r.writeOutput || "").trim()
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
        content: `文案${i + 1}\n\n${(r.writeOutput || "").trim()}`,
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
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <input id="autoSplitAi" type="checkbox" checked={autoSplitByAI} onChange={(e) => setAutoSplitByAI(e.target.checked)} />
                  <Label htmlFor="autoSplitAi">启用AI辅助拆分（可选，占位）</Label>
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
                          <Label>原文（只读）</Label>
                          <Textarea readOnly value={t.raw} className="min-h-[120px]" />
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

              <div className="space-y-4 mt-4">
                {results
                  .sort((a, b) => a.index - b.index)
                  .map((r, i) => (
                    <div key={r.id} className="rounded-md border p-4 space-y-3 bg-white/50 dark:bg-white/5 backdrop-blur-sm">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">文案{ i + 1 }</div>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="secondary" onClick={() => safeCopy((r.writeOutput || "").trim())}>复制正文</Button>
                          <Button size="sm" onClick={() => saveToNoteApi([r.id])}>保存到笔记</Button>
                        </div>
                      </div>
                      {r.searchOutput && (
                        <details className="text-sm text-muted-foreground">
                          <summary className="cursor-pointer">检索结果（传递给写作）</summary>
                          <pre className="whitespace-pre-wrap mt-2">{stripThinking(r.searchOutput)}</pre>
                        </details>
                      )}
                      <div className="text-sm">
                        <pre className="whitespace-pre-wrap">{r.writeOutput}</pre>
                      </div>
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
                            const task = tasks.find((t) => t.id === r.id)
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
                                  `\n\n【当前文案】\n${r.writeOutput || ""}`,
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
                              setResults((prev) => prev.map((x) => x.id === r.id ? { ...x, writeOutput: newOut, createdAt: Date.now() } : x))
                              toast.success("已完成微调")
                            } catch (e: any) {
                              toast.error(`微调失败：${e?.message || e}`)
                            } finally {
                              setStages((prev) => {
                                const next = { ...prev }; delete next[r.id]; return next
                              })
                            }
                          }}>
                            {stages[r.id] === "微调中" ? "微调中..." : "基于此继续微调"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-6">
          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>API 配置（OpenAI 兼容）</CardTitle>
              <CardDescription>分别为"搜索增强模型"和"文案生成模型"设置 API Endpoint、Key 和模型名。支持任意 OpenAI 兼容服务商。</CardDescription>
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
              </div>
              <div className="space-y-3">
                <div className="text-sm font-medium">笔记 API</div>
                <Input placeholder="Endpoint，如 https://dinoai.chatgo.pro/openapi/text/input" value={noteApi.endpoint} onChange={(e) => setNoteApi({ ...noteApi, endpoint: e.target.value })} />
                <Input placeholder="Authorization（API Key）" value={noteApi.apiKey} onChange={(e) => setNoteApi({ ...noteApi, apiKey: e.target.value })} />
              </div>
            </CardContent>
          </Card>

          <Card className="bg-white/60 dark:bg-neutral-900/40 backdrop-blur-md border border-white/40 dark:border-white/10 shadow-[0_1px_0_0_rgba(255,255,255,0.4)_inset,0_8px_30px_rgba(0,0,0,0.06)]">
            <CardHeader>
              <CardTitle>提示词管理</CardTitle>
              <CardDescription>统一在此管理。取消 API 配置中的 Prompt 字段，避免歧义。可设置默认：搜索增强 / 文案生成。</CardDescription>
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
              <CardDescription>导出所有配置（API、提示词、默认项、笔记API），便于迁移与备份。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-3">
                <Button variant="secondary" onClick={() => safeCopy(exportAll())}>复制导出JSON</Button>
                <Button onClick={() => {
                  const txt = prompt("粘贴导出JSON以导入：")
                  if (!txt) return
                  try { importAll(txt); toast.success("导入成功，刷新页面后生效") } catch (e: any) { toast.error(`导入失败：${e?.message || e}`) }
                }}>导入JSON</Button>
              </div>
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
    const item: PromptItem = { id: crypto.randomUUID(), name: name.trim(), category, content }
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
                    <Button size="sm" variant={defaults.defaultSearchPromptId === p.id ? "default" : "secondary"} onClick={() => onDefaultsChange({ ...defaults, defaultSearchPromptId: p.id })}>
                      设为默认搜索
                    </Button>
                  )}
                  {(p.category === "文案生成" || p.category === "自定义") && (
                    <Button size="sm" variant={defaults.defaultWritePromptId === p.id ? "default" : "secondary"} onClick={() => onDefaultsChange({ ...defaults, defaultWritePromptId: p.id })}>
                      设为默认写作
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