/**
 * dsh-skill-lazy — DSH skill 目录懒加载 + MECE 原则执行器
 *
 * 问题：官方 dsh-tool-skill 每个新会话把全部 67 个 skill 的摘要（name + ≤500 字符描述）
 *       注入 <available_skills>，约 9500 字符 ≈ 3K tokens 常驻首轮上下文，命中率却很低。
 *
 * 方案（C 混合路线，用户 2026-08-18 拍板）：
 *   1. 目录精简：agent/pre-step 把官方注入的 skill-catalog 消息文本替换为
 *      「名字 + 一行短摘要（≤40 字符）」，按调用频率降序排列，附 skill_search 使用提示。
 *      source.entries 保持不变 → 官方 digest/去重逻辑不受影响。
 *   2. skill_search：按查询词从完整摘要目录检索，返回按 MECE 领域分组的命中结果
 *      （组间互斥、组内穷尽），并附领域覆盖检查（缺口提示）。
 *   3. skill_mece_check：创建/评估技能前跑 MECE 检查——互斥性（与现有技能的重叠度
 *      + 重叠原因）+ 穷尽性（领域覆盖矩阵 + 空域/弱域标记），输出建议。
 *   4. 频率记录：tools/post-execute 监听 skill 工具调用，usage.json 跨会话累计，
 *      目录排序用（高频在前）。
 *
 * 不动的部分：官方 skill 工具正文懒加载、/手势 直连、userInvocable 注入。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-skill-lazy'
export const inject = ['tools', 'agents', 'skills']
export const Config = null

const HOME = homedir()
const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname)
const USAGE_FILE = join(PLUGIN_DIR, 'usage.json')
const SKILLS_DIR = join(HOME, '.dsh', 'skills')

// ---------- MECE 领域映射（互斥且穷尽） ----------
// name → 领域 id 精确映射（67 个存量 skill 全量归类；新增未映射 skill 走关键词兜底 → other）
const DOMAIN_MAP = {
  'a-share-daily-analyst': 'a-share',
  'a-share-daily-report-pipeline': 'a-share',
  'a-share-market-analyst': 'a-share',
  'a-share-market-data': 'a-share',
  'a-share-market-news': 'a-share',
  'chief-of-staff': 'gov-doc',
  'chinese-official-documents': 'gov-doc',
  'gongwen-format': 'gov-doc',
  'gongwen-polish': 'gov-doc',
  'gongwen-writing-methods': 'gov-doc',
  'meeting-minutes': 'gov-doc',
  'senior-government-report-writing': 'gov-doc',
  'docx': 'office-doc',
  'nano-pdf': 'office-doc',
  'ocr-and-documents': 'office-doc',
  'officecli': 'office-doc',
  'pdf': 'office-doc',
  'pdf-cjk': 'office-doc',
  'powerpoint': 'office-doc',
  'ppt-structure-expert': 'office-doc',
  'xlsx': 'office-doc',
  'cli-anything': 'dev',
  'codebase-inspection': 'dev',
  'deepseek-harness-operations': 'dev',
  'project-analysis': 'dev',
  'project-context': 'dev',
  'python-debugpy': 'dev',
  'systematic-debugging': 'dev',
  'time-bomb-patching': 'dev',
  'github-auth': 'github',
  'github-blocked-fallback': 'github',
  'github-code-review': 'github',
  'github-issues': 'github',
  'github-pr-workflow': 'github',
  'github-project-assessment': 'github',
  'github-repo-management': 'github',
  'github-trending-cn': 'github',
  'chinese-publication-research': 'writing',
  'grounded-citations': 'writing',
  'humanizer': 'writing',
  'resume-authoring': 'writing',
  'agent-memory-system-design': 'memory-kb',
  'honcho-memory-setup': 'memory-kb',
  'llm-wiki': 'memory-kb',
  'memory': 'memory-kb',
  'obsidian': 'memory-kb',
  'siyuan-note': 'memory-kb',
  'task-context': 'memory-kb',
  'task-management': 'memory-kb',
  'wiki-ops': 'memory-kb',
  'huashu-nuwa': 'thinking',
  'maozedong-perspective': 'thinking',
  'mckinsey-content-editor': 'thinking',
  'policy-analysis-expert': 'thinking',
  'ponytail': 'thinking',
  'stepwise-execution': 'thinking',
  'linux-service-longevity': 'ops',
  'vaultwarden-selfhosted': 'ops',
  'computer-use': 'ops',
  'architecture-diagram': 'design',
  'multimodal-image-analysis': 'design',
  'web-content-capture': 'design',
  'interrupted-session-recovery': 'dsh-platform',
  'evaluating-ai-tools': 'research',
  'financial-report-deep-analysis': 'research',
  'technical-counter-examples': 'research',
  'hermes-agent-skill-authoring': 'skill-eng',
}

const DOMAINS = [
  { id: 'a-share', label: 'A股投资', keywords: ['A股', '股票', '行情', '复盘', '北向', '涨停', 'market', 'stock'] },
  { id: 'gov-doc', label: '政务公文', keywords: ['公文', '请示', '通知', '报告', '纪要', '汇报', '讲话', 'gongwen', 'official'] },
  { id: 'office-doc', label: '办公文档', keywords: ['Word', 'Excel', 'PPT', 'PDF', 'docx', 'xlsx', 'pptx', '排版', '文档'] },
  { id: 'dev', label: '代码开发', keywords: ['调试', 'debug', '代码', 'CLI', 'harness', 'patch', '编译', 'git'] },
  { id: 'github', label: 'GitHub 生态', keywords: ['github', 'pull request', 'merge request', 'issue', 'clone', 'repository', 'repo ', 'ci/cd', 'github action'] },
  { id: 'writing', label: '写作与内容', keywords: ['写作', '润色', '简历', '引用', '出版', 'humanize', 'citations'] },
  { id: 'memory-kb', label: '记忆与知识管理', keywords: ['记忆', '召回', 'wiki', '笔记', 'Obsidian', '思源', 'memory', '知识库'] },
  { id: 'thinking', label: '思维框架', keywords: ['思维', '框架', '分析', '矛盾', '麦肯锡', '结构化', 'perspective'] },
  { id: 'ops', label: '系统运维', keywords: ['运维', '部署', 'Docker', '服务', 'vaultwarden', '长寿', 'service'] },
  { id: 'design', label: '视觉与设计', keywords: ['架构图', 'SVG', '图片', '图像', '设计', '截图', 'vision'] },
  { id: 'dsh-platform', label: 'DSH 平台', keywords: ['dsh', '会话恢复', '中断', 'resume', 'harness'] },
  { id: 'research', label: '分析与研究', keywords: ['研究', '评估', '财报', '反例', '调研', 'research', 'audit'] },
  { id: 'skill-eng', label: '技能工程', keywords: ['技能工程', '技能蒸馏', '技能门禁', 'skill_audit', 'skill_scaffold', 'skill 创建', 'skill 蒸馏'] },
  { id: 'other', label: '其他', keywords: [] },
]

// ---------- 工具函数 ----------

/** 描述 → 一行短摘要（取首句，≤max 字符） */
function shorten(desc, max = 40) {
  const normalized = String(desc || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  const firstSentence = normalized.split(/[。！？!?.]/)[0] || normalized
  return firstSentence.length <= max ? firstSentence : `${firstSentence.slice(0, max - 1)}…`
}

/** 伪 XML 转义（与官方同款，防描述破坏 <skill_content> 框架） */
function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** 从 catalog 消息 source.entries 读 {name, description}[] */
function readCatalogEntries(source) {
  const entries = source?.entries
  if (!Array.isArray(entries)) return void 0
  const out = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return void 0
    const { name, description } = entry
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return void 0
    out.push({ name, description })
  }
  return out
}

// ---------- usage 读写 ----------

function loadUsage() {
  try {
    if (!existsSync(USAGE_FILE)) return {}
    return JSON.parse(readFileSync(USAGE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function bumpUsage(name) {
  try {
    const usage = loadUsage()
    usage[name] = (usage[name] || 0) + 1
    mkdirSync(PLUGIN_DIR, { recursive: true })
    writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2))
  } catch {
    // 记录失败不阻塞
  }
}

// ---------- catalog 精简渲染 ----------

function renderCompactCatalog(entries, usage, cfg, query = '') {
  const maxLen = cfg.catalogDescriptionMaxLength ?? 40
  const sortByUsage = cfg.sortByUsage ?? true
  const foldEnabled = cfg.foldEnabled ?? true
  const foldKeepDomains = cfg.foldKeepDomains ?? 1   // 展开的匹配域数
  const foldKeepFrequent = cfg.foldKeepFrequent ?? 5 // 额外展开的高频 skill 数
  const sorted = sortByUsage
    ? [...entries].sort((a, b) => (usage[b.name] || 0) - (usage[a.name] || 0) || a.name.localeCompare(b.name))
    : entries

  // 领域折叠（2026-08-21，杠杆 2）：按当前任务 query 判定匹配域，
  // 只展开「匹配域 + 高频 skill」，其余域折叠成一行（需要时 skill_search）。
  let lines = []
  let folded = [] // {domain, count, names}
  if (foldEnabled && query && query.trim()) {
    const taskDomain = domainOf('', query) // query 直接判域（无 name）
    const freqNames = new Set(sorted.slice(0, foldKeepFrequent).map((e) => e.name))
    const expanded = []
    const foldedByDomain = new Map()
    for (const e of sorted) {
      const dom = domainOf(e.name, e.description)
      if (freqNames.has(e.name) || dom === taskDomain || taskDomain === 'other') {
        expanded.push(e)
      } else {
        const rec = foldedByDomain.get(dom) || { count: 0, names: [] }
        rec.count += 1
        rec.names.push(e.name)
        foldedByDomain.set(dom, rec)
      }
    }
    lines = expanded.map((e) => `- \`${e.name}\`: ${escapeText(shorten(e.description, maxLen))}`)
    for (const [dom, rec] of foldedByDomain) {
      const label = DOMAINS.find((d) => d.id === dom)?.label || dom
      lines.push(`- ⏳ 另有 ${rec.count} 个 ${label} skill（${rec.names.slice(0, 6).map((n) => `\`${n}\``).join(' ')}…）：需要时用 skill_search 检索`)
    }
  } else {
    lines = sorted.map((e) => `- \`${e.name}\`: ${escapeText(shorten(e.description, maxLen))}`)
  }
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. This is a compact catalog (name + one-line summary, sorted by usage). The following skills are available in this session:',
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
    'For full descriptions and cross-skill matching, call the `skill_search` tool with your task keywords — results come grouped by MECE domains with coverage-gap hints. When creating or evaluating a skill, call `skill_mece_check` first to verify mutual exclusivity and full coverage against the existing library.',
    'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    '</system-reminder>'
  ].join('\n')
}

// ---------- MECE 工具：领域归类 / 分组 / 覆盖矩阵 / 重叠检测 ----------

function domainOf(name, description) {
  const direct = DOMAIN_MAP[name]
  if (direct) return direct
  const text = `${name} ${description || ''}`.toLowerCase()
  for (const d of DOMAINS) {
    if (d.id === 'other') continue
    for (const k of d.keywords) {
      // 英文关键词最短 3 字符，避免 CI/PR 这类 2 字符词误匹配（如 simplicity 里的 "ci"）
      if (/^[a-z][a-z0-9 /-]*$/.test(k) && k.length < 3) continue
      if (text.includes(k.toLowerCase())) return d.id
    }
  }
  return 'other'
}

/** 把一批 skill 按领域分组（组间互斥：每 skill 唯一归属；组内穷尽：列出全部命中） */
function groupByDomain(skills) {
  const groups = new Map(DOMAINS.map((d) => [d.id, []]))
  for (const s of skills) {
    const id = domainOf(s.name, s.description)
    groups.get(id).push(s)
  }
  return groups
}

/** 领域覆盖矩阵：每个领域存量技能数与缺口标记 */
function coverageMatrix(allSkills) {
  const counts = new Map(DOMAINS.map((d) => [d.id, 0]))
  const members = new Map(DOMAINS.map((d) => [d.id, []]))
  for (const s of allSkills) {
    const id = domainOf(s.name, s.description)
    counts.set(id, (counts.get(id) || 0) + 1)
    members.get(id).push(s.name)
  }
  return DOMAINS.map((d) => ({
    id: d.id,
    label: d.label,
    count: counts.get(d.id) || 0,
    members: (members.get(d.id) || []).sort(),
    gap: (counts.get(d.id) || 0) === 0 ? '空域' : (counts.get(d.id) || 0) < 2 ? '弱域' : '正常'
  }))
}

/** 描述 → 关键词集合（英文单词 + 中文连续串，去停用词） */
const STOP_WORDS = new Set(['the','a','an','and','or','of','to','in','for','with','on','as','by','from','use','using','when','what','how','this','that','is','are','be','do','does','can','will','should','document','file','create','make','your','you','user','skill','skills','输出','输入','用于','使用','场景','用户','文档','文件','进行','以及','或者','如果','需要'])
function keywordsOf(text) {
  const t = String(text || '')
  const en = (t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP_WORDS.has(w))
  const cn = (t.match(/[\u4e00-\u9fa5]{2,4}/g) || [])
  return [...new Set([...en, ...cn])]
}

/** 互斥性：新技能与现有技能的重叠检测，返回 top 重叠项 */
function overlapCheck(newName, newDesc, allSkills) {
  const newKw = keywordsOf(`${newName} ${newDesc}`)
  if (newKw.length === 0) return []
  const scored = []
  for (const s of allSkills) {
    const base = keywordsOf(`${s.name} ${s.description}`)
    const shared = newKw.filter((k) => base.includes(k))
    if (shared.length === 0) continue
    scored.push({
      name: s.name,
      shared,
      ratio: shared.length / newKw.length, // 新技能被现有技能覆盖的比例
    })
  }
  return scored.sort((a, b) => b.ratio - a.ratio || b.shared.length - a.shared.length).slice(0, 6)
}

// ---------- skill_search 打分 ----------

function scoreSkill(query, skill) {
  const q = query.toLowerCase()
  const name = skill.name.toLowerCase()
  const desc = `${skill.description || ''} ${skill.whenToUse || ''} ${skill.triggers || ''}`.toLowerCase()
  let score = 0
  // 完整词/子串命中
  if (name.includes(q)) score += 100
  if (desc.includes(q)) score += 30
  // 2026-08-19 补充：用户消息点名技能名（query 含完整 kebab 名）→ 强相关 +100
  if (q.includes(name)) score += 100
  // 中文 2-gram 交集（2026-08-19 增强，借鉴 L1 lane1）：query 与 desc 共享的相邻两字
  // 解决「改插件」这类动作+对象查询——对象词「插件」与 desc 的 2-gram 命中即可计分
  if (/[\u4e00-\u9fa5]/.test(q)) {
    const qb = new Set()
    for (let i = 0; i + 1 < q.length; i += 1) qb.add(q.slice(i, i + 2))
    const db = new Set()
    for (let i = 0; i + 1 < desc.length; i += 1) db.add(desc.slice(i, i + 2))
    let inter = 0
    for (const g of qb) if (db.has(g)) inter += 1
    if (inter >= 1) score += 3 * inter
  }
  // 查询分词命中
  const tokens = keywordsOf(query)
  for (const t of tokens) {
    if (name.includes(t)) { score += 12; continue }
    if (desc.includes(t)) { score += 4; continue }
    // 中文连续词拆分 bigram 补充匹配：query 的"公文排版"应对应描述中的"公文按…排版"（两词被隔开）
    if (/^[\u4e00-\u9fa5]{3,}$/.test(t)) {
      const grams = new Set()
      for (let i = 0; i + 1 < t.length; i += 1) grams.add(t.slice(i, i + 2))
      let hits = 0
      for (const g of grams) if (desc.includes(g)) hits += 1
      if (hits >= 2) score += 3 * hits
    }
  }
  return score
}

// ---------- 插件主体 ----------

export function apply(ctx, config = {}) {
  const cfg = {
    catalogDescriptionMaxLength: config.catalogDescriptionMaxLength ?? 40,
    topK: config.topK ?? 6,
    sortByUsage: config.sortByUsage ?? true,
    matchThreshold: config.matchThreshold ?? 6, // 主动匹配提示的相关度阈值（2026-08-19 新增）
    foldEnabled: config.foldEnabled ?? true,        // 领域折叠开关（2026-08-21 杠杆 2）
    foldKeepDomains: config.foldKeepDomains ?? 1,   // 展开的匹配域数
    foldKeepFrequent: config.foldKeepFrequent ?? 5, // 额外展开的高频 skill 数
  }
  const state = { lastHintSig: '' }

  // ---------- 技能元数据读取（ctx.skills.list 优先，fallback 读 SKILLS_DIR frontmatter） ----------
  /** 给 skill 对象补充 triggers（官方 list 不保证返回；从 SKILL.md frontmatter 行级提取） */
  function enrichTriggers(skills) {
    return (skills || []).map((s) => {
      if (s.triggers) return s
      try {
        const f = join(SKILLS_DIR, s.name, 'SKILL.md')
        if (!existsSync(f)) return s
        const raw = readFileSync(f, 'utf8')
        const fm = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!fm) return s
        const lines = fm[1].split('\n')
        const ti = lines.findIndex((l) => l.trim() === 'triggers:')
        if (ti === -1) return s
        const triggers = []
        for (let j = ti + 1; j < lines.length; j += 1) {
          const mm = lines[j].match(/^\s*-\s*["']?(.+?)["']?\s*$/)
          if (mm) triggers.push(mm[1])
          else break
        }
        return triggers.length ? { ...s, triggers: triggers.join(' ') } : s
      } catch { return s }
    })
  }

  async function listAllSkills(ctx) {
    try {
      const all = await ctx.skills.list({})
      if (Array.isArray(all) && all.length > 0) return enrichTriggers(all)
    } catch { /* fallthrough */ }
    const out = []
    try {
      for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const f = join(SKILLS_DIR, d.name, 'SKILL.md')
        if (!existsSync(f)) continue
        const raw = readFileSync(f, 'utf8')
        const fm = raw.match(/^---\n([\s\S]*?)\n---/)
        if (!fm) continue
        const meta = { name: d.name, description: '', whenToUse: '', triggers: '' }
        for (const line of fm[1].split('\n')) {
          const m = line.match(/^(description|whenToUse|triggers):\s*(.*)$/)
          if (m) meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
        }
        out.push(meta)
      }
    } catch { /* 读取失败返回已收集部分 */ }
    return out
  }

  /** 取最新真实用户消息文本（跳过 skill-catalog 与插件注入消息） */
  function extractLatestUserText(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      const src = m?.source
      if (src?.kind === 'skill-catalog' || src?.kind === 'plugin') continue
      const content = m.content
      const text = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : '')
      if (text && text.trim()) return text.slice(0, 300)
    }
    return ''
  }

  /** 生成主动匹配提示（top-3，相关度 ≥ 阈值） */
  function buildMatchHint(query, all, usage) {
    if (!query) return null
    const scored = all
      .map((s) => ({ s, score: scoreSkill(query, s) }))
      .filter((x) => x.score >= cfg.matchThreshold)
      .sort((a, b) => b.score - a.score)
    if (scored.length === 0) return null
    const lines = ['[技能匹配提示] 当前任务可能与以下 skill 相关，按需用 skill 工具加载（不相关可忽略）：']
    for (const { s, score } of scored.slice(0, 3)) {
      const cnt = usage[s.name] || 0
      lines.push(`- \`${s.name}\`（相关度 ${score}${cnt ? `，已用 ${cnt} 次` : ''}）：${shorten(s.description, 50)}`)
    }
    return lines.join('\n')
  }

  // ---------- 1. agent/pre-step：catalog 精简 + 技能匹配提示 ----------
  // Cordis waterfall 是 outermost-first：官方 dsh-tool-skill 先注册成为外层，
  // 若本钩子默认 push 注册（inner），会先于官方拿到原始消息（无 catalog）→
  // 替换永不命中。必须 prepend 到监听器最前：本钩子先执行 await next()，
  // 等官方注入完成后拿到含 catalog 的消息，再替换其文本为精简版
  // （source 不动 → digest 不变，官方去重逻辑不受影响）。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const messages = decision.messages || []
    let updated = decision
    // (a) catalog 精简（原有逻辑）+ 领域折叠（2026-08-21：按当前任务 query 折叠非匹配域）
    const idx = messages.findIndex((m) => m?.source?.kind === 'skill-catalog')
    if (idx !== -1) {
      const msg = messages[idx]
      const entries = readCatalogEntries(msg.source)
      if (entries && entries.length > 0) {
        const query = extractLatestUserText(updated.messages || messages)
        const text = renderCompactCatalog(entries, loadUsage(), cfg, query)
        updated = { ...updated, messages: messages.map((m, i) => (i === idx ? { ...m, content: [{ type: 'text', text }] } : m)) }
      }
    }
    // (b) 技能匹配提示（2026-08-19 L1：把「模型自觉匹配」变成「系统提示匹配」；
    //     同一条用户消息只提示一次——state.lastHintSig 去重，避免工具轮重复刷屏）
    try {
      const query = extractLatestUserText(updated.messages || messages)
      if (query) {
        const all = await listAllSkills(ctx)
        if (all.length > 0) {
          const hint = buildMatchHint(query, all, loadUsage())
          if (hint) {
            const sig = query.slice(0, 40)
            if (state.lastHintSig !== sig) {
              state.lastHintSig = sig
              const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
              const hintMsg = createUserMessage({
                content: [{ type: 'text', text: hint }],
                source: { kind: 'plugin', plugin: 'dsh-skill-lazy' },
              })
              return { ...updated, messages: [...(updated.messages || messages), hintMsg] }
            }
          }
        }
      }
    } catch { /* 匹配提示失败不阻塞回合 */ }
    return updated
  }, { prepend: true })

  // ---------- 2. tools/post-execute：skill 调用频率 ----------
  // 2026-08-19 修复：rc.7 createExecution 的参数字段是 `arguments` 不是 `args`（坑 10），
  // 原代码读 exec?.args?.name 恒 undefined → usage 统计静默失效（usage.json 永远是空）。
  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      const toolName = exec?.tool?.name || exec?.name || exec?.id || ''
      const argsName = exec?.arguments?.name ?? exec?.args?.name
      if (toolName === 'skill' && argsName) bumpUsage(String(argsName))
    } catch {
      // 频率记录失败不阻塞调用
    }
    return next()
  })

  // ---------- 3. skill_search：按需检索 + MECE 分组 ----------
  ctx.tools.register(defineTool({
    name: 'skill_search',
    description: '按关键词检索技能库，返回按 MECE 领域分组的结果与领域覆盖报告。任务可能对应多个技能、或紧凑目录不够用时先用它。',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords describing the task (Chinese or English).' },
      limit: { type: 'number', description: `Max hits per domain group (default ${cfg.topK}).` },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const query = String(input.query || '').trim()
      if (!query) return '[skill_search] 需要 query 参数'
      const lookup = {
        cwd: exec.agent?.session?.header?.cwd,
        signal: exec.signal,
        scope: exec.agent,
      }
      let all = []
      try {
        all = enrichTriggers(await ctx.skills.list(lookup))
      } catch {
        all = []
      }
      if (all.length === 0) return '[skill_search] 技能目录不可用'

      const limit = Math.max(1, Math.min(20, Number(input.limit) || cfg.topK))
      const scored = all
        .map((s) => ({ s, score: scoreSkill(query, s) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)

      const usage = loadUsage()
      const lines = []
      lines.push(`# skill_search: "${query}"（命中 ${scored.length}/${all.length}）`)
      lines.push('')

      if (scored.length === 0) {
        lines.push('未命中任何技能。')
      } else {
        const groups = groupByDomain(scored.map((x) => x.s))
        lines.push('## 命中结果（MECE 分组：组间互斥、组内按相关度排序）')
        for (const d of DOMAINS) {
          const hits = groups.get(d.id) || []
          if (hits.length === 0) continue
          lines.push('')
          lines.push(`### ${d.label}（${hits.length}）`)
          for (const s of hits) {
            const cnt = usage[s.name] || 0
            const when = s.whenToUse ? `\n  whenToUse: ${s.whenToUse.split('\n')[0].slice(0, 120)}` : ''
            lines.push(`- \`${s.name}\`（调用 ${cnt} 次）: ${s.description}${when}`)
          }
        }
      }

      // 领域覆盖检查（穷尽性）
      const matrix = coverageMatrix(all)
      lines.push('')
      lines.push('## 领域覆盖检查（穷尽性）')
      const flags = matrix.filter((m) => m.gap !== '正常')
      for (const m of matrix) {
        lines.push(`- ${m.label}: ${m.count} 个技能 ${m.gap === '正常' ? '' : `⚠️ ${m.gap}`}`)
      }
      if (flags.length === 0) {
        lines.push('')
        lines.push('✅ 全部领域有技能覆盖，无缺口。')
      } else {
        lines.push('')
        lines.push(`⚠️ 缺口领域：${flags.map((f) => f.label).join(' / ')}（如需覆盖，可用 skill_mece_check 评估新建技能的必要性与重叠风险）`)
      }
      return lines.join('\n')
    },
  }))

  // ---------- 4. skill_mece_check：创建技能前 MECE 检查 ----------
  ctx.tools.register(defineTool({
    name: 'skill_mece_check',
    description: 'MECE check before creating or evaluating a skill. Given the proposed skill name and description, checks (1) mutual exclusivity — keyword overlap against every existing skill, with the shared keywords and overlap ratio, and (2) collective exhaustiveness — the domain coverage matrix of the whole skill library, flagging empty/weak domains and recommending where the new skill fits. Run this before scaffolding any new skill, and when auditing whether the library is complete.',
    parameters: {
      name: { type: 'string', required: true, description: 'Proposed skill name (kebab-case, e.g. my-new-skill).' },
      description: { type: 'string', required: true, description: 'Proposed skill description: what it does + when to use.' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input, exec) {
      const name = String(input.name || '').trim()
      const description = String(input.description || '').trim()
      if (!name || !description) return '[skill_mece_check] 需要 name 和 description'
      const lookup = {
        cwd: exec.agent?.session?.header?.cwd,
        signal: exec.signal,
        scope: exec.agent,
      }
      let all = []
      try {
        all = await ctx.skills.list(lookup)
      } catch {
        all = []
      }
      if (all.length === 0) return '[skill_mece_check] 技能目录不可用'

      const existing = all.some((s) => s.name === name)
      const targetDomain = domainOf(name, description)
      const dLabel = DOMAINS.find((d) => d.id === targetDomain)?.label || targetDomain

      const lines = []
      lines.push(`# skill_mece_check: "${name}"`)
      lines.push('')
      lines.push(`**归属领域（MECE 归类）**：${dLabel}`)
      if (existing) lines.push(`⚠️ 同名技能已存在：\`${name}\` —— 建议改为更新现有技能，而非新建。`)
      lines.push('')

      // 互斥性
      lines.push('## ① 互斥性（Mutually Exclusive）— 与现有技能重叠检测')
      const overlaps = overlapCheck(name, description, all)
      if (overlaps.length === 0) {
        lines.push('- ✅ 与现有技能无显著关键词重叠。')
      } else {
        lines.push(`- ⚠️ 检测到 ${overlaps.length} 个重叠候选（覆盖比例 = 现有技能包含新技能关键词的比例）：`)
        for (const o of overlaps) {
          lines.push(`  - \`${o.name}\` 覆盖 ${Math.round(o.ratio * 100)}% —— 共享词: ${o.shared.join(' / ')}`)
        }
        lines.push('')
        lines.push('  判定建议：')
        lines.push('  - 覆盖比例 > 50% → 高度重叠，优先考虑**扩展现有技能**而非新建；')
        lines.push('  - 30%~50% → 边界需在 whenToUse/Boundaries 中显式划清，防误触；')
        lines.push('  - < 30% → 重叠可接受，但仍需在描述中区分触发场景。')
      }
      lines.push('')

      // 穷尽性
      lines.push('## ② 穷尽性（Collectively Exhaustive）— 领域覆盖矩阵')
      const matrix = coverageMatrix(all)
      for (const m of matrix) {
        const mark = m.id === targetDomain ? ' ← 新技能落位' : ''
        lines.push(`- ${m.label}: ${m.count} 个技能 ${m.gap === '正常' ? '' : `⚠️ ${m.gap}`}${mark}`)
      }
      const target = matrix.find((m) => m.id === targetDomain)
      lines.push('')
      if (target && target.count === 0) {
        lines.push(`✅ 新技能将填补「${dLabel}」空域（${all.length + 1} 个技能后领域覆盖更完整）。`)
      } else if (target && target.count < 2) {
        lines.push(`ℹ️ 「${dLabel}」目前是弱域（${target.count} 个），新技能加入后仍建议后续审视是否需要更多覆盖。`)
      } else {
        lines.push(`ℹ️ 「${dLabel}」已有 ${target?.count ?? 0} 个技能，属正常覆盖；若新技能与它们边界清晰（见①），可接受。`)
      }
      lines.push('')
      lines.push('**结论**：是否新建由你拍板。若①无高重叠、②落位合理 → 可走 skill_scaffold 创建；若①高重叠 → 建议先更新现有技能。')
      return lines.join('\n')
    },
  }))

  // ---------- 4. cost_audit：token 成本审计（2026-08-21 控制论落地） ----------
  // 前馈表条目：插件工具描述总量 > 阈值 → 触发瘦身/折叠决策。
  // 工具给数字（描述字符/token 估算），模型给判断（是否瘦身）。
  ctx.tools.register(defineTool({
    name: 'cost_audit',
    description: 'token 成本审计：统计全部插件工具 description 与 skill 目录的字符/token 开销，对照预算阈值（工具描述默认 1500 tokens、skill 目录默认 800 tokens），超阈值提示瘦身/折叠。插件越建越多时的成本看门狗（控制论前馈：先观测再开药）。',
    parameters: {
      pluginDir: { type: 'string', required: true, description: '插件目录（默认 ~/.dsh/plugins；可省略）' },
      toolBudgetTokens: { type: 'number', required: true, description: '工具描述 token 预算（默认 1500；可省略）' },
      skillBudgetTokens: { type: 'number', required: true, description: 'skill 目录 token 预算（默认 800；可省略）' },
    },
    output: {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: value }],
    },
    async execute(input) {
      const HOME = homedir()
      const pluginDir = input?.pluginDir ? String(input.pluginDir).replace(/^~/, HOME) : join(HOME, '.dsh', 'plugins')
      const toolBudget = Number(input?.toolBudgetTokens) || 1500
      const skillBudget = Number(input?.skillBudgetTokens) || 800
      const lines = ['[cost_audit] token 成本审计', '']

      // ① 插件工具描述统计
      let toolChars = 0
      const perPlugin = []
      try {
        for (const d of readdirSync(pluginDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const f = join(pluginDir, d.name, 'index.js')
          if (!existsSync(f)) continue
          const text = readFileSync(f, 'utf8')
          const descs = text.match(/description:\s*'([^']{20,})'/g) || []
          const chars = descs.reduce((s, x) => s + x.length - 16, 0) // 去掉 description: ' 包裹
          toolChars += chars
          perPlugin.push([d.name, chars])
        }
      } catch (e) {
        lines.push(`⚠️ 插件目录读取失败: ${e.message}`)
      }
      const toolTokens = Math.round(toolChars / 4)
      lines.push(`① 插件工具描述: ${toolChars} 字符 ≈ ${toolTokens} tokens/轮（预算 ${toolBudget}）`)
      for (const [name, chars] of perPlugin.sort((a, b) => b[1] - a[1])) {
        const mark = chars > 700 ? ' ⚠️ 超 700 字符建议瘦身' : ''
        lines.push(`  - ${name}: ${chars} 字符 ≈ ${Math.round(chars / 4)} tokens${mark}`)
      }
      if (toolTokens > toolBudget) {
        lines.push(`  ❌ 超预算 ${toolTokens - toolBudget} tokens → 建议：对超长描述（>700 字符）瘦身，细节移 skill 文档`)
      } else {
        lines.push(`  ✅ 预算内（余 ${toolBudget - toolTokens} tokens）`)
      }

      // ② skill 目录统计
      let skillChars = 0
      try {
        for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
          if (!d.isDirectory()) continue
          const f = join(SKILLS_DIR, d.name, 'SKILL.md')
          if (!existsSync(f)) continue
          const raw = readFileSync(f, 'utf8')
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)
          if (!fm) continue
          const descM = fm[1].match(/^description:\s*(.+)$/m)
          if (descM) skillChars += descM[1].trim().length
        }
      } catch (e) {
        lines.push(`⚠️ skill 目录读取失败: ${e.message}`)
      }
      const skillTokens = Math.round(skillChars / 4)
      lines.push('')
      lines.push(`② skill 目录: ${skillChars} 字符 ≈ ${skillTokens} tokens/轮（预算 ${skillBudget}，已含领域折叠压减）`)
      if (skillTokens > skillBudget) {
        lines.push(`  ❌ 超预算 → 检查 foldEnabled 是否开启、或精简 description（第一句 ≤40 字符）`)
      } else {
        lines.push(`  ✅ 预算内`)
      }

      // ③ 结论
      lines.push('')
      lines.push(`合计固定开销: ~${toolTokens + skillTokens} tokens/轮`)
      lines.push('控制论注：工具给数字，模型给判断——超预算项先确认"是否影响好用度"再瘦身；瘦身后观测回归（pHat 不升即为安全）。')
      return lines.join('\n')
    },
  }))
}
