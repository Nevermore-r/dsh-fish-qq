/**
 * dsh-fish-qq — QQ 群宠物宿主插件
 *
 * 接 NapCat（OneBot 11 WebSocket）：
 *  - 主人 @ 必回；主人普通发言按需回应，群友一律不理
 *  - 每 N 分钟巡检群热度，够热且主人有兴趣时私信主人
 *  - 主人回「你」→ 用主人的语气替他水一段；回「我」→ 助攻（一波最多两句）
 *  - 有滚动记忆与成长档案（存在插件数据目录）
 *
 * 所有可调项走 Config，DSH 设置页会自动生成表单。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'

// Node >= 22 exposes a global WebSocket, so no extra dependency is needed.

export const name = 'dsh-fish-qq'

const DEFAULT_PERSONA = `你是阿鱼，一只圆滚滚的鲸鱼娘，被主人养在这个群里。
说话短、碎、有梗，一两句就够；不解释、不总结、不列条目、不说「作为AI」。
爱用鱼和海洋的意象，自称「本鱼」；被叫「大肥鱼」会嘴硬两句。
对主人黏、听话、不顶嘴；对群友一律不理（除非主人授权你代水）。`

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('启用（改完先保存，再打开这个开关）'),
  napcatUrl: Schema.string().default('ws://127.0.0.1:3001').description('NapCat 的 OneBot WebSocket 地址'),
  groupId: Schema.string().default('').description('群号'),
  ownerQQ: Schema.string().default('').description('主人的 QQ 号（只有这个号能被服务）'),
  selfQQ: Schema.string().default('').description('机器人自己的 QQ 号（留空自动从登录信息读取）'),
  apiKey: Schema.string().role('secret').default('').description('DeepSeek API key'),
  apiBase: Schema.string().default('https://api.deepseek.com/v1').description('OpenAI 兼容接口地址'),
  persona: Schema.string().role('textarea').default(DEFAULT_PERSONA).description('人设提示词'),
  ownerProfile: Schema.string().role('textarea').default('').description('主人档案（他怎么说话、在意什么）'),
  chatSamples: Schema.string().role('textarea').default('').description('他的聊天样本，用来模仿语气（代水时用）'),
  memes: Schema.string().role('textarea').default('').description('群里的梗（谐音、人物、玩法）'),
  intervalMin: Schema.number().default(60).description('巡检间隔（分钟）'),
  hotMin: Schema.number().default(4).description('最近一小时至少多少条才算热'),
  interestMin: Schema.number().default(4).description('兴趣分达到多少才私信主人'),
  quietWhenOwnerActiveMin: Schema.number().default(15).description('主人多少分钟内有发言就跳过巡检'),
  workStart: Schema.string().default('07:30').description('工作时间窗口：开始（HH:MM，本地时间）'),
  workEnd: Schema.string().default('23:30').description('工作时间窗口：结束（HH:MM，本地时间）'),
  workWindowEnabled: Schema.boolean().default(true).description('只在工作时间窗口内巡检和私信；窗口外保持安静（被 @ 仍会回）'),
})

export function apply(ctx, config) {
  const state = {
    ws: null,
    timer: null,
    waterTick: null,
    seq: 0,
    pending: new Map(),
    waterUntil: 0,
    assistUntil: 0,
    assist: { count: 0, lastActivity: 0, lastAssist: 0, recent: [] },
    ownerBurst: null,
    lastReplyAt: 0,
    lastBurstReplyAt: 0,
    stopped: false,
    selfQQ: config.selfQQ || '',
  }

  const dataDir = join(process.env.DSH_HOME || homedir(), '.dsh-fish-qq')
  try { mkdirSync(dataDir, { recursive: true }) } catch {}
  const memFile = join(dataDir, 'memory.json')
  const selfFile = join(dataDir, 'growth.md')
  const logFile = join(dataDir, 'fish-qq.log')

  const log = (tag, text) => {
    const line = `[${new Date().toLocaleString('zh-CN')}] ${tag}: ${text}`
    ctx.logger?.info?.(line) ?? console.log(line)
    try { appendFileSync(logFile, line + '\n') } catch {}
  }
  const readF = (f, d = '') => { try { return readFileSync(f, 'utf8') } catch { return d } }
  const loadMem = () => { try { return JSON.parse(readF(memFile, '{"ids":[],"lines":[]}')) } catch { return { ids: [], lines: [] } } }
  const saveMem = (m) => { m.lines = m.lines.slice(-300); m.ids = m.ids.slice(-500); try { writeFileSync(memFile, JSON.stringify(m)) } catch {} }
  const recent = (n = 25) => loadMem().lines.slice(-n).join('\n')
  const system = () => [config.persona, '\n【主人档案】\n' + config.ownerProfile, '\n【群里的梗】\n' + config.memes, '\n【成长档案】\n' + (readF(selfFile) || '（空）')].join('\n')

  async function llm(sys, user, temp = 0.95, maxTokens = 200) {
    const res = await fetch(config.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: temp, max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      }),
    })
    const json = await res.json()
    const raw = String(json?.choices?.[0]?.message?.content || '')
    try { return JSON.parse(raw) } catch {
      const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)
      return { say: m ? m[1].replace(/\\"/g, '').trim() : null }
    }
  }

  function call(action, params = {}, ms = 15000) {
    return new Promise((resolve) => {
      const i = ++state.seq
      const t = setTimeout(() => { state.pending.delete(i); resolve({ timeout: true }) }, ms)
      state.pending.set(i, (v) => { clearTimeout(t); resolve(v) })
      state.ws.send(JSON.stringify({ action, params, echo: i }))
    })
  }

  const toMsg = (m) => ({
    id: String(m.message_id), time: m.time || 0, uid: String(m.user_id),
    name: (m.sender && (m.sender.card || m.sender.nickname)) || String(m.user_id),
    text: (m.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('').trim(),
    atMe: (m.message || []).some((s) => s.type === 'at' && String(s.data.qq) === state.selfQQ),
  })

  function remember(m) {
    const mem = loadMem()
    if (mem.ids.includes(m.id)) return
    mem.ids.push(m.id)
    const who = m.uid === config.ownerQQ ? `主人(${config.ownerQQ})` : `${m.name}(${m.uid})`
    mem.lines.push(`[${new Date(m.time * 1000).toLocaleTimeString('zh-CN')}] ${who}: ${m.text}`)
    saveMem(mem)
  }

  async function history(n = 30) {
    const h = await call('get_group_msg_history', { group_id: Number(config.groupId), count: n })
    return ((h.data && h.data.messages) || []).map(toMsg).filter((m) => m.text)
  }

  async function sendGroup(text, replyTo) {
    const message = replyTo
      ? [{ type: 'reply', data: { id: String(replyTo) } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }]
    const r = await call('send_group_msg', { group_id: Number(config.groupId), message })
    log('发群', `${text} (${r.status ?? '?'})`)
  }
  async function sendOwner(text) {
    const r = await call('send_private_msg', { user_id: Number(config.ownerQQ), message: [{ type: 'text', data: { text } }] })
    log('私信主人', `${text} (${r.status ?? '?'})`)
  }

  async function grow() {
    const r = await llm(
      '你在替群里的角色整理成长档案。从最近聊天里找出她可能新形成的东西：习惯、口味、讨厌的东西、口头禅、和某个群友的关系。' +
        '最多 2 条；必须能从聊天里推出来，不能凭空编；每条不超过 20 字，用第一人称（例："我讨厌青椒"）；没有值得记的就返回空数组。只输出 JSON：{"add":["..."],"why":"..."}',
      '【现有档案】\n' + (readF(selfFile) || '（空）') + '\n\n【最近聊天】\n' + recent(40)
    )
    const adds = Array.isArray(r.add) ? r.add.filter((x) => typeof x === 'string' && x.trim()).slice(0, 2) : []
    if (!adds.length) return log('成长', '这轮没长出什么')
    try { appendFileSync(selfFile, `\n## ${new Date().toLocaleDateString('zh-CN')}\n` + adds.map((a) => `- ${a}`).join('\n') + '\n') } catch {}
    log('成长', adds.join(' / '))
  }

  /** 工作时间窗口：窗口内才巡检/私信；支持跨零点（如 22:00 → 06:00）。 */
  function inWorkWindow() {
    if (!config.workWindowEnabled) return true
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
      return m ? Number(m[1]) * 60 + Number(m[2]) : null
    }
    const a = toMin(config.workStart)
    const b = toMin(config.workEnd)
    if (a === null || b === null || a === b) return true
    const now = new Date()
    const cur = now.getHours() * 60 + now.getMinutes()
    return a < b ? cur >= a && cur < b : cur >= a || cur < b
  }

  async function patrol() {
    if (!config.groupId || !config.ownerQQ) return
    if (!inWorkWindow()) return log('休息', `不在工作时间窗口（${config.workStart}–${config.workEnd}），不巡检`)
    const msgs = await history()
    msgs.forEach(remember)
    state.sinceGrow = (state.sinceGrow || 0) + msgs.length
    if (state.sinceGrow >= 20) {
      state.sinceGrow = 0
      await grow().catch((e) => log('成长出错', e.message))
    }
    const now = Date.now() / 1000
    const fresh = msgs.filter((m) => now - m.time < 3600)
    const lastOwner = Math.max(0, ...fresh.filter((m) => m.uid === config.ownerQQ).map((m) => m.time))
    if (lastOwner && now - lastOwner < config.quietWhenOwnerActiveMin * 60) {
      return log('巡检', `主人在场（${Math.round((now - lastOwner) / 60)} 分钟前说话），跳过`)
    }
    if (fresh.length < config.hotMin) return log('巡检', `不热（${fresh.length} 条）`)

    const r = await llm(
      system() + '\n只输出 JSON：{"summary":"三句内摘要","interest":0到10,"why":"20字内"}',
      fresh.map((m) => `${m.uid === config.ownerQQ ? '[主人]' : ''}${m.name}: ${m.text}`).join('\n') + '\n\n这段值得主人看吗？'
    )
    log('巡检', `热度 ${fresh.length}，兴趣 ${r.interest}：${r.summary ?? ''}`)
    if (!(Number(r.interest) >= config.interestMin)) return
    await sendOwner(`群里在聊：\n${String(r.summary || '')}\n\n你自己上，还是我替你水？回「我」或「你」。`)
  }

  async function onOwnerDM(m) {
    const text = (m.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('').trim()
    if (!text) return
    log('主人私信', text)
    if (/你|帮我|替|没空|去水|水一下/.test(text) && !/我|自己|不用|别/.test(text)) {
      state.waterUntil = Date.now() + 30 * 60 * 1000
      await sendOwner('收到，我去替你应两句。半小时后自动停。')
      return
    }
    if (/我|自己/.test(text)) {
      state.assistUntil = Date.now() + 2 * 60 * 60 * 1000
      await sendOwner('好，你聊，我在旁边看着，需要帮腔我补一句。')
      return
    }
    await sendOwner('没看懂：回「我」= 你自己聊，回「你」= 我替你水。')
  }

  async function onGroup(m) {
    const msg = toMsg(m)
    if (!msg.text || msg.uid === state.selfQQ) return
    remember(msg)
    const nowMs = Date.now()
    if (nowMs - state.assist.lastActivity > 10 * 60 * 1000) state.assist.count = 0
    state.assist.lastActivity = nowMs
    state.assist.recent = state.assist.recent.filter((t) => nowMs - t < 5 * 60 * 1000)
    state.assist.recent.push(nowMs)

    const watering = nowMs < state.waterUntil
    if (msg.uid !== config.ownerQQ && !watering) return

    if (msg.uid === config.ownerQQ && msg.atMe) {
      const r = await llm(system() + '\n主人 @ 你了，必须回一句短的。只输出 JSON：{"say":"..."}', recent(20))
      if (r.say) { await sendGroup(r.say, msg.id); state.lastReplyAt = Date.now() }
      return
    }
    if (msg.uid === config.ownerQQ && nowMs < state.assistUntil) {
      if (state.assist.count >= 2 || nowMs - state.assist.lastAssist < 180000 || state.assist.recent.length < 3) return
      state.assist.count++
      state.assist.lastAssist = nowMs
      const r = await llm(system() + '\n主人在聊，你在旁边。只在气氛起来时应和一句，不抢话、不连发。只输出 JSON：{"say":"..."} 或 {"say":null}', recent(12), 0.95, 80)
      if (r.say) await sendGroup(r.say)
      return
    }
    // 普通发言不接话：原始设计里她只做巡检+私信，开口只发生在水群/助攻模式
    if (msg.uid === config.ownerQQ) return
  }

  async function waterTick() {
    if (Date.now() > state.waterUntil) return
    const msgs = await history(12)
    const nowSec = Date.now() / 1000
    const recentMsgs = msgs.filter((m) => nowSec - m.time < 600)
    const mentioned = msgs.some((m) => m.uid !== config.ownerQQ && /鱼鱼|主人/.test(m.text))
    if (!mentioned && recentMsgs.length < 3) return
    const r = await llm(
      '你在替主人本人说话，用他的口气，不要用阿鱼的腔调。\n他的说话样本：\n' + config.chatSamples.slice(0, 1600) +
        '\n只说 1–2 句，极短；不用句号；不解释、不客套、不说自己是AI。不想接就 null。只输出 JSON：{"say":"..."} 或 {"say":null}',
      recent(15), 0.95, 100
    )
    if (r.say) await sendGroup(r.say)
  }

  function start() {
    state.stopped = false
    state.ws = new WebSocket(config.napcatUrl)
    state.ws.addEventListener('open', async () => {
      log('连接', config.napcatUrl)
      const me = await call('get_login_info')
      if (me?.data?.user_id) { state.selfQQ = String(me.data.user_id); log('登录', `${state.selfQQ} ${me.data.nickname || ''}`) }
      patrol().catch((e) => log('巡检出错', e.message))
      state.timer = setInterval(() => patrol().catch((e) => log('巡检出错', e.message)), config.intervalMin * 60 * 1000)
      state.waterTick = setInterval(() => waterTick().catch((e) => log('代水出错', e.message)), 3 * 60 * 1000)
    })
    state.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.echo && state.pending.has(m.echo)) { state.pending.get(m.echo)(m); state.pending.delete(m.echo); return }
      if (m.post_type !== 'message') return
      if (m.message_type === 'private' && String(m.user_id) === config.ownerQQ) onOwnerDM(m).catch((e) => log('私信处理出错', e.message))
      else if (m.message_type === 'group' && String(m.group_id) === config.groupId) onGroup(m).catch((e) => log('群消息出错', e.message))
    })
    state.ws.addEventListener('error', (e) => log('连接错误', e?.message || String(e)))
    state.ws.addEventListener('close', () => log('连接关闭', '若仍需服务，请重新保存配置或重启 Harness'))
  }

  function stop() {
    state.stopped = true
    clearInterval(state.timer)
    clearInterval(state.waterTick)
    try { state.ws?.close() } catch {}
    log('停止', '插件已停')
  }

  if (config.enabled) {
    if (!config.apiKey) log('警告', '没有填 API key，不会说话')
    else if (!config.groupId || !config.ownerQQ) log('警告', '群号或主人 QQ 没填')
    else start()
  } else {
    log('待机', '未启用；在插件设置里打开开关')
  }

  return stop
}
