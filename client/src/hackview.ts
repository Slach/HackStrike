// Hacker view (M2, GDD §12.6): full-screen DOM overlay in CRT-terminal
// style, visible between "jackin" and "jackout"/death. Tiled WM of panels:
// F1 = deck, F2+ = controlled devices; CMD/CTRL+T new tab, CMD/CTRL+W close,
// CMD/CTRL+1..9 / F1..F9 switch, CMD/CTRL+H/V split (up to 2×2). The server
// stays the single source of truth — this UI only renders deck/scan/snap
// data and sends run/ctrl intents.
//
// Rendering split: render() rebuilds the structure (rare — tab/pane/scan
// changes); deck samples (2 Hz) and door states update existing nodes in
// place, so a pending button click is never swallowed by a re-render.

import type {
  CamSeen,
  ClientMessage,
  DeckProg,
  PropKind,
  RunProg,
  ScanDevice,
  ServerMessage,
  SnapProp,
} from './net'

type JackinMsg = Extract<ServerMessage, { t: 'jackin' }>
type DeckMsg = Extract<ServerMessage, { t: 'deck' }>
type ScanMsg = Extract<ServerMessage, { t: 'scan' }>
type DeniedMsg = Extract<ServerMessage, { t: 'denied' }>
type CamMsg = Extract<ServerMessage, { t: 'cam' }>

export interface HackViewDeps {
  send: (msg: ClientMessage) => void
  teamOf: (playerId: number) => number | null
}

const DENIED_TEXT: Readonly<Record<string, string>> = {
  ram_full: 'RAM ПОЛНА — ОСТАНОВИ ПРОГРАММУ',
  not_vulned: 'НЕТ УЯЗВИМОСТИ — СНАЧАЛА VULNSCAN',
  not_owner: 'НЕ ВЛАДЕЛЕЦ',
  not_jacked: 'НЕ В СЕТИ',
  no_los: 'НЕТ ПРЯМОЙ ВИДИМОСТИ',
  too_far: 'СЛИШКОМ ДАЛЕКО',
  bad_target: 'НЕВЕРНАЯ ЦЕЛЬ',
  antivirus: 'ANTIVIRUS — УСТАНОВКА TROJAN ОТБИТА',
}

const KIND_LABEL: Readonly<Record<PropKind, string>> = {
  terminal: 'ТЕРМИНАЛ',
  radio: 'РАДИО-ТОЧКА',
  switch: 'SWITCH',
  door: 'ДВЕРЬ',
  camera: 'КАМЕРА',
  cable: 'КАБЕЛЬ',
}

const PROG_LABEL: Readonly<Record<string, string>> = {
  portscan: 'PORTSCAN',
  vulnscan: 'VULNSCAN',
  trojan: 'TROJAN',
  watcher: 'WATCHER',
  firewall: 'FIREWALL',
  antivirus: 'ANTIVIRUS',
}

/** Программы слэш-палитры (ГДД §13.3) — порядок = порядок ряда хоткеев 1..6. */
const PALETTE_PROGS: readonly RunProg[] = [
  'portscan',
  'vulnscan',
  'trojan',
  'watcher',
  'firewall',
  'antivirus',
]

/** Короткие алиасы kind для фильтра палитры: /term, /cam (ГДД §13.3). */
const KIND_ALIAS: Readonly<Record<string, PropKind>> = {
  term: 'terminal',
  radio: 'radio',
  switch: 'switch',
  door: 'door',
  cam: 'camera',
}

/** Кандидат слэш-палитры: устройство или программа. */
interface PalCand {
  kind: 'dev' | 'prog'
  /** Что вставляется в токен при автодополнении. */
  text: string
  dev?: string
  prog?: RunProg
  label: string
  hint: string
}

const HISTORY_MAX = 60 // 30 с истории при 2 Гц deck-сообщений
const SPARK_W = 176
const SPARK_H = 34
const MAX_PANES = 4
const TOAST_MS = 2600

interface Tab {
  key: string // 'deck' | `dev:${id}`
  dev: string | null
}

interface Pane {
  tabKey: string
}

interface SparkRef {
  canvas: HTMLCanvasElement
  value: HTMLElement
  key: 'cpu' | 'npu' | 'ram' | 'net'
}

function byId(id: string): HTMLElement {
  const e = document.getElementById(id)
  if (e === null) throw new Error(`hackview: missing #${id}`)
  return e
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls !== undefined && cls !== '') e.className = cls
  return e
}

function txt<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text: string): HTMLElementTagNameMap[K] {
  const e = el(tag, cls)
  e.textContent = text
  return e
}

function svgEl(name: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', name)
}

/** Спарклайн: линия с заливкой, правый край = свежий срез. */
function drawSpark(canvas: HTMLCanvasElement, samples: readonly number[]): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(SPARK_W * dpr)
  canvas.height = Math.round(SPARK_H * dpr)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  ctx.scale(dpr, dpr)
  ctx.fillStyle = 'rgba(55,255,155,0.05)'
  ctx.fillRect(0, 0, SPARK_W, SPARK_H)
  if (samples.length > 1) {
    const step = SPARK_W / (HISTORY_MAX - 1)
    const x0 = SPARK_W - (samples.length - 1) * step
    ctx.beginPath()
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(0, Math.min(1, samples[i]))
      const x = x0 + i * step
      const y = SPARK_H - 2 - v * (SPARK_H - 4)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = '#37ff9b'
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.lineTo(SPARK_W, SPARK_H)
    ctx.lineTo(x0, SPARK_H)
    ctx.closePath()
    ctx.fillStyle = 'rgba(55,255,155,0.1)'
    ctx.fill()
  }
  ctx.strokeStyle = 'rgba(55,255,155,0.25)'
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, SPARK_W - 1, SPARK_H - 1)
}

function keyIndex(code: string, prefix: 'Digit' | 'F'): number | null {
  if (!code.startsWith(prefix)) return null
  const n = Number(code.slice(prefix.length))
  return Number.isInteger(n) && n >= 1 && n <= 9 ? n - 1 : null
}

function gridClass(panes: number, dir: 'h' | 'v'): string {
  if (panes <= 1) return 'g1'
  if (panes === 2) return dir === 'h' ? 'g2h' : 'g2v'
  return 'g4'
}

export class HackView {
  private readonly root: HTMLElement
  private readonly main: HTMLElement
  private readonly toasts: HTMLElement
  private raf: number | null = null
  private pendingJobs: (() => void)[] = []
  private _active = false

  private myId: number | null = null
  private host = ''
  private hostKind: PropKind | null = null
  private netMbps = 0
  private deckRam = 4
  private progs: readonly DeckProg[] = []
  private readonly hist = {
    cpu: [] as number[],
    npu: [] as number[],
    ram: [] as number[],
    net: [] as number[],
  }
  /** Обнаруженные устройства живут между джек-инами (туман войны — свои знания). */
  private devices = new Map<string, ScanDevice>()
  private readonly doorOpen = new Map<string, boolean>()
  private target: string | null = null
  private vulned = new Map<string, true>()
  /** Устройства с моим watcher-триггером (M3 §13.1) — для ореола на карте. */
  private watched = new Map<string, true>()
  /** Устройства с firewall и его хозяин (M3 §13.5) — ореол/бейдж + тост. */
  private firewalled = new Map<string, number>()
  /** Устройства с чьим-то antivirus (M3 §13.6) — ореол + тост об установке. */
  private antivirused = new Map<string, true>()
  /** Ленты камер (M3 §13.7): последний «кадр» по каждой МОЕЙ камере; живёт
   *  между перестройками DOM и обновляется на месте (клики не срываются). */
  private readonly camFeeds = new Map<string, readonly CamSeen[]>()
  /** Рапорт камеры (плейтест M3): время первого кадра по камере — «T+мм:сс»
   *  uptime ленты; предыдущий кадр — направление движения целей (Δ между
   *  кадрами 2 Гц); последний контакт — пустой стейт «N с назад». */
  private readonly camFirstFrame = new Map<string, number>()
  private readonly camPrevFrame = new Map<string, ReadonlyMap<number, CamSeen>>()
  private readonly camLastContact = new Map<string, { name: string; at: number }>()
  private tabs: Tab[] = [{ key: 'deck', dev: null }]
  private panes: Pane[] = [{ tabKey: 'deck' }]
  private activePane = 0
  private splitDir: 'h' | 'v' = 'h'
  private menuOpen = false
  // Слэш-палитра (§13.3): командная строка запуска программ с клавиатуры.
  private palette: { wrap: HTMLElement; input: HTMLInputElement; list: HTMLElement } | null = null
  private paletteCands: readonly PalCand[] = []
  private paletteSel = -1
  /** Токен, который дополняет Tab: 0 = устройство, 1 = программа. */
  private paletteTok: 0 | 1 = 0
  private readonly cmdHistory: string[] = []
  private histIdx = 0

  // Refs для точечных обновлений без перестройки DOM (клики не срываются).
  private sparkRefs: SparkRef[] = []
  private progLists: HTMLElement[] = []
  private netmapBoxes: HTMLElement[] = []
  private doorRefs: { dev: string; status: HTMLElement; btn: HTMLButtonElement }[] = []
  private camRefs: { dev: string; list: HTMLElement; time: HTMLElement; count: HTMLElement }[] = []

  constructor(private deps: HackViewDeps) {
    this.root = byId('hackview')
    this.root.classList.add('hidden')
    this.main = el('div', 'hv-main')
    this.toasts = el('div', 'hv-toasts')
    this.root.append(this.main, this.toasts)
    window.addEventListener('keydown', this.onKeyDown)
  }

  get active(): boolean {
    return this._active
  }

  /** Палитра открыта: ESC/Backspace принадлежат ей (закрытие), не джек-ауту. */
  get isPaletteOpen(): boolean {
    return this.palette !== null
  }

  setMyId(id: number | null): void {
    this.myId = id
  }

  activate(msg: JackinMsg, hostKind: PropKind | null): void {
    this._active = true
    this.host = msg.host
    this.hostKind = hostKind
    this.netMbps = msg.deck.net
    this.deckRam = msg.deck.ram > 0 ? msg.deck.ram : 4
    this.progs = []
    this.hist.cpu.length = 0
    this.hist.npu.length = 0
    this.hist.ram.length = 0
    this.hist.net.length = 0
    this.target = null
    this.tabs = [{ key: 'deck', dev: null }]
    this.panes = [{ tabKey: 'deck' }]
    this.activePane = 0
    this.menuOpen = false
    this.root.classList.remove('hidden')
    this.render()
  }

  deactivate(): void {
    if (!this._active) return
    this._active = false
    this.menuOpen = false
    this.closePalette()
    this.pendingJobs = []
    if (this.raf !== null) {
      window.cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.root.classList.add('hidden')
    this.main.replaceChildren()
    this.sparkRefs = []
    this.progLists = []
    this.netmapBoxes = []
    this.doorRefs = []
    this.camRefs = []
  }

  onDeck(msg: DeckMsg): void {
    this.push('cpu', msg.cpuLoad)
    this.push('npu', msg.npuLoad)
    this.push('ram', msg.ramUsed)
    this.push('net', msg.netLoad)
    this.progs = msg.progs
    this.schedule(() => this.updateDeckData())
  }

  onScan(msg: ScanMsg): void {
    const next = new Map<string, ScanDevice>()
    for (const d of msg.devices) next.set(d.id, d)
    // vulnscan завершился: сервер присылает vulned:true — хакер должен это
    // увидеть (иначе «нажал 2 и ничего не произошло»).
    for (const d of msg.devices) {
      if (d.vulned && !this.vulned.has(d.id)) {
        this.toast(`УЯЗВИМОСТЬ НАЙДЕНА: ${d.id.toUpperCase()} — ТРОЯНЬ [3]`)
      }
    }
    this.vulned = new Map([...next].filter(([, d]) => d.vulned === true).map(([id]) => [id, true] as const))
    // Обратная связь watcher'а (§13.1): установка видна на карте и тостом.
    for (const d of msg.devices) {
      if (d.watched === true && !this.watched.has(d.id)) {
        this.toast(`WATCHER АКТИВЕН: ${d.id.toUpperCase()}`)
      }
    }
    this.watched = new Map([...next].filter(([, d]) => d.watched === true).map(([id]) => [id, true] as const))
    // Обратная связь firewall (§13.5): фильтр наблюдаем из сети; тост — на
    // новое появление или смену хозяина (чей — видно в подписи бейджа).
    for (const d of msg.devices) {
      const by = d.firewalled === true ? d.firewalledBy ?? 0 : 0
      if (by !== 0 && this.firewalled.get(d.id) !== by) {
        this.toast(`FIREWALL: ${d.id.toUpperCase()} (${this.fwLabel(by)})`)
      }
    }
    this.firewalled = new Map(
      [...next]
        .filter(([, d]) => d.firewalled === true && d.firewalledBy !== undefined)
        .map(([id, d]) => [id, d.firewalledBy as number] as const),
    )
    // Обратная связь antivirus (§13.6): резидентный процесс видим всем
    // скавшим; износ (oreol исчез) — атакующий видит, что путь открыт.
    for (const d of msg.devices) {
      if (d.antivirused === true && !this.antivirused.has(d.id)) {
        this.toast(`ANTIVIRUS: ${d.id.toUpperCase()}`)
      }
    }
    this.antivirused = new Map([...next].filter(([, d]) => d.antivirused === true).map(([id]) => [id, true] as const))
    // Таб на устройство при появлении владения (ГДД §12.6).
    for (const d of msg.devices) {
      if (d.owner !== null && d.owner === this.myId && !this.tabs.some((t) => t.dev === d.id)) {
        this.tabs.push({ key: `dev:${d.id}`, dev: d.id })
        if (this._active) {
          this.toast(`ЗАХВАЧЕНО: ${d.id.toUpperCase()} (${KIND_LABEL[d.kind]}) — F${this.tabs.length - 1}`)
        }
      }
    }
    // §13.7: камеру у меня отобрали — лента гаснет (иначе висел бы старый кадр).
    for (const [id, d] of next) {
      if (d.kind === 'camera' && d.owner !== this.myId) {
        this.camFeeds.delete(id)
        this.camFirstFrame.delete(id)
        this.camPrevFrame.delete(id)
        this.camLastContact.delete(id)
      }
    }
    this.tabs = this.tabs.filter((t) => t.dev === null || next.has(t.dev))
    for (const p of this.panes) {
      if (!this.tabs.some((t) => t.key === p.tabKey)) p.tabKey = 'deck'
    }
    if (this.target !== null && !next.has(this.target)) this.target = null
    this.devices = next
    this.schedule(() => this.render())
  }

  onDenied(msg: DeniedMsg): void {
    if (!this._active) return
    this.toast(DENIED_TEXT[msg.reason] ?? `ОТКАЗАНО: ${msg.reason}`)
  }

  /** Сработал watcher (M3 §13.2): чужой джек-ин в устройство с моим триггером. */
  onAlert(text: string): void {
    if (!this._active) return
    this.toast(text)
  }

  /** Лента камеры (M3 §13.7): «кадр» 2 Гц по моей камере. Храним даже вне
   *  hackview — открыв таб, хакер видит последний кадр сразу. */
  onCam(msg: CamMsg): void {
    this.camFeeds.set(msg.dev, msg.seen)
    const now = performance.now()
    if (!this.camFirstFrame.has(msg.dev)) this.camFirstFrame.set(msg.dev, now)
    // контакт есть → обновляем «последний контакт» (кадр атомарен, время одно)
    if (msg.seen.length > 0) {
      const prev = this.camLastContact.get(msg.dev)
      const keep = prev !== undefined && msg.seen.some((s) => s.name === prev.name) ? prev.name : msg.seen[msg.seen.length - 1].name
      this.camLastContact.set(msg.dev, { name: keep, at: now })
    }
    this.schedule(() => this.updateCamFeeds())
  }

  /** Состояние дверей из snap.props (без перестройки DOM). */
  updateProps(props: readonly SnapProp[]): void {
    let changed = false
    for (const p of props) {
      if (p.kind !== 'door' || p.open === undefined) continue
      if (this.doorOpen.get(p.id) !== p.open) {
        this.doorOpen.set(p.id, p.open)
        changed = true
      }
    }
    if (changed) this.schedule(() => this.updateDoorStates())
  }

  // ── раскладка WM ────────────────────────────────────────────────────────

  private schedule(job: () => void): void {
    if (!this._active) return
    this.pendingJobs.push(job)
    if (this.raf !== null) return
    this.raf = window.requestAnimationFrame(() => {
      this.raf = null
      const jobs = this.pendingJobs
      this.pendingJobs = []
      for (const j of jobs) j()
    })
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this._active) return
    const mod = e.ctrlKey || e.metaKey
    // CTRL/CMD+ALT+DEL перехватывает main.ts (шлёт jackout) — здесь только
    // не отдаём комбинацию браузеру повторно.
    if (e.altKey && mod && e.code === 'Delete') {
      e.preventDefault()
      return
    }
    // Палитра открыта — дека-хоткеи заблокированы, кроме её навигации
    // (ГДД §13.3); CTRL/CMD+ALT+DEL выше уже отдан main.ts.
    if (this.palette !== null) {
      this.onPaletteKey(e)
      return
    }
    if (e.code === 'Escape' && this.menuOpen) {
      e.preventDefault()
      this.menuOpen = false
      this.schedule(() => this.render())
      return
    }
    if (mod && !e.altKey) {
      if (e.code === 'KeyT') {
        e.preventDefault()
        this.menuOpen = !this.menuOpen
        this.schedule(() => this.render())
        return
      }
      if (e.code === 'KeyW') {
        e.preventDefault()
        this.closeActiveTab()
        return
      }
      if (e.code === 'KeyH') {
        e.preventDefault()
        this.split('h')
        return
      }
      if (e.code === 'KeyV') {
        e.preventDefault()
        this.split('v')
        return
      }
      const d = keyIndex(e.code, 'Digit')
      if (d !== null && d < this.tabs.length) {
        e.preventDefault()
        this.panes[this.activePane].tabKey = this.tabs[d].key
        this.schedule(() => this.render())
      }
      return
    }
    const f = keyIndex(e.code, 'F')
    if (f !== null) {
      e.preventDefault() // F1 иначе открывает помощь браузера
      if (f < this.tabs.length) {
        this.panes[this.activePane].tabKey = this.tabs[f].key
        this.schedule(() => this.render())
      }
      return
    }
    // Хоткеи программ — пока активна панель деки (ГДД §12.6).
    const pane = this.panes[this.activePane]
    if (pane === undefined || pane.tabKey !== 'deck') return
    // e.code — физическая клавиша: слэш открывает палитру в любой раскладке
    // (в русской e.key = '.', а code всё равно 'Slash'). Firefox иначе
    // открывает quick-find.
    if (e.code === 'Slash' && !e.altKey) {
      e.preventDefault()
      this.openPalette()
      return
    }
    if (e.code === 'Digit1') {
      e.preventDefault()
      this.runProg('portscan')
    } else if (e.code === 'Digit2') {
      e.preventDefault()
      this.runProg('vulnscan')
    } else if (e.code === 'Digit3') {
      e.preventDefault()
      this.runProg('trojan')
    } else if (e.code === 'Digit4') {
      e.preventDefault()
      this.runProg('watcher')
    } else if (e.code === 'Digit5') {
      e.preventDefault()
      this.runProg('firewall')
    } else if (e.code === 'Digit6') {
      e.preventDefault()
      this.runProg('antivirus')
    }
  }

  private split(dir: 'h' | 'v'): void {
    if (this.panes.length >= MAX_PANES) {
      this.toast('МАКСИМУМ 4 ПАНЕЛИ')
      return
    }
    if (this.panes.length === 1) this.splitDir = dir
    const shown = new Set(this.panes.map((p) => p.tabKey))
    const tab = this.tabs.find((t) => !shown.has(t.key)) ?? this.tabs[0]
    this.panes.push({ tabKey: tab.key })
    this.activePane = this.panes.length - 1
    this.schedule(() => this.render())
  }

  private removePane(i: number): void {
    if (this.panes.length <= 1) return
    this.panes.splice(i, 1)
    this.activePane = Math.min(this.activePane, this.panes.length - 1)
    this.schedule(() => this.render())
  }

  private closeActiveTab(): void {
    const pane = this.panes[this.activePane]
    const tab = this.tabs.find((t) => t.key === pane.tabKey)
    if (tab === undefined || tab.dev === null) {
      this.toast('ДЕКА НЕ ЗАКРЫВАЕТСЯ')
      return
    }
    this.tabs = this.tabs.filter((t) => t !== tab)
    for (const p of this.panes) {
      if (p.tabKey === tab.key) p.tabKey = 'deck'
    }
    this.schedule(() => this.render())
  }

  private ensureTab(dev: string, focus: boolean): void {
    let tab = this.tabs.find((t) => t.dev === dev)
    if (tab === undefined) {
      tab = { key: `dev:${dev}`, dev }
      this.tabs.push(tab)
    }
    if (focus) this.panes[this.activePane].tabKey = tab.key
  }

  private activatePane(i: number): void {
    if (this.activePane === i || this.panes[i] === undefined) return
    this.activePane = i
    // только классы, без перестройки — клик по кнопке панели не сорвётся
    this.main.querySelectorAll('.hv-pane').forEach((n, idx) => n.classList.toggle('active', idx === i))
  }

  private runProg(prog: RunProg): void {
    this.runProgAt(prog, null)
  }

  /** Запуск программы; dev — до-поленная цель слэш-палитры (null = this.target).
   *  Гейты и протокол те же, что у кнопок/хоткеев деки (§13.3). */
  private runProgAt(prog: RunProg, dev: string | null): void {
    const needDev = prog !== 'portscan'
    const target = dev ?? this.target
    if (needDev && target === null) {
      this.toast('ВЫБЕРИТЕ ЦЕЛЬ НА КАРТЕ СЕТИ')
      return
    }
    if (dev !== null) this.target = dev
    const devSuffix = needDev && target !== null ? ` → ${target.toUpperCase()}` : ''
    this.deps.send(
      needDev && target !== null ? { t: 'run', prog, dev: target } : { t: 'run', prog },
    )
    this.toast(`ЗАПУЩЕНО: ${PROG_LABEL[prog] ?? prog}${devSuffix}`)
  }

  private toast(text: string): void {
    const t = el('div', 'hv-toast')
    t.textContent = text
    this.toasts.append(t)
    window.setTimeout(() => {
      t.classList.add('fade')
      window.setTimeout(() => t.remove(), 500)
    }, TOAST_MS)
  }

  // ── слэш-палитра (ГДД §13.3) ────────────────────────────────────────────

  private onPaletteKey(e: KeyboardEvent): void {
    const pal = this.palette
    if (pal === null) return
    if (e.ctrlKey || e.metaKey) {
      // Блокируем дека-комбинации (T/W/H/V/Digit), остальные браузерные
      // шорткаты (копипаст и т.п.) не трогаем.
      if (e.altKey) return // CTRL/CMD+ALT+DEL уже обработан выше
      if (['KeyT', 'KeyW', 'KeyH', 'KeyV'].includes(e.code) || keyIndex(e.code, 'Digit') !== null) {
        e.preventDefault()
      }
      return
    }
    if (keyIndex(e.code, 'F') !== null) {
      e.preventDefault() // F-табы заблокированы, F1 не открывает помощь
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      this.closePalette()
      return
    }
    if (e.key === 'Tab' || e.key === 'ArrowDown') {
      e.preventDefault()
      this.paletteCycle(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (pal.input.value.trim() === '') this.recallHistory()
      else this.paletteCycle(-1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      this.paletteRun()
    }
    // Остальное — обычный ввод в строку фильтра (input-событие обновит список).
  }

  private openPalette(): void {
    if (this.palette !== null) return
    const wrap = el('div', 'hv-palette')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hv-pal-input'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = 'фильтр устройства + программа — напр. cam1 port'
    input.addEventListener('input', () => {
      this.paletteSel = -1
      this.updatePalette()
    })
    const list = el('div', 'hv-pal-list')
    const hint = el('div', 'hv-pal-hint')
    hint.textContent = 'TAB ДОПОЛНИТЬ · ↑↓ ВЫБОР · ↑ ИСТОРИЯ · ENTER ЗАПУСК · ESC ЗАКРЫТЬ'
    wrap.append(input, list, hint)
    this.root.append(wrap)
    this.palette = { wrap, input, list }
    this.paletteSel = -1
    this.histIdx = 0
    this.updatePalette()
    input.focus()
  }

  private closePalette(): void {
    if (this.palette === null) return
    this.palette.wrap.remove()
    this.palette = null
    this.paletteCands = []
    this.paletteSel = -1
  }

  /** Устройство подходит под токен: подстрока в id или kind (с алиасами
   *  term/cam); пустой токен подходит всем (§13.3). */
  private devMatch(d: ScanDevice, q: string): boolean {
    if (q === '') return true
    const alias = KIND_ALIAS[q]
    return d.id.includes(q) || d.kind.includes(q) || (alias !== undefined && d.kind === alias)
  }

  private updatePalette(): void {
    const pal = this.palette
    if (pal === null) return
    const tokens = pal.input.value.trim().split(/\s+/).filter((t) => t !== '')
    const dq = (tokens[0] ?? '').toLowerCase()
    const pq = (tokens[1] ?? '').toLowerCase()
    const cands: PalCand[] = []
    this.paletteTok = tokens.length > 1 ? 1 : 0
    if (this.paletteTok === 0) {
      // Первый токен: устройства (только из текущего скана), потом программы.
      const devs = [...this.devices.values()]
        .filter((d) => this.devMatch(d, dq))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      for (const d of devs) {
        cands.push({
          kind: 'dev',
          text: d.id,
          dev: d.id,
          label: `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`,
          hint: this.ownerLabel(d.owner),
        })
      }
      for (const p of PALETTE_PROGS) {
        if (p.includes(dq)) {
          cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint: 'ПРОГРАММА' })
        }
      }
    } else {
      // Второй токен: программы поверх уже отфильтрованного устройства.
      for (const p of PALETTE_PROGS) {
        if (p.includes(pq)) {
          cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint: 'ПРОГРАММА' })
        }
      }
    }
    this.paletteCands = cands
    if (this.paletteSel >= cands.length) this.paletteSel = cands.length - 1
    pal.list.replaceChildren()
    const MAX_SHOWN = 8
    cands.slice(0, MAX_SHOWN).forEach((c, i) => {
      const row = el('div', 'hv-pal-cand' + (i === this.paletteSel ? ' sel' : ''))
      row.append(txt('span', 'hv-pal-name', c.label))
      row.append(txt('span', 'hv-pal-hintc', c.hint))
      pal.list.append(row)
    })
    if (cands.length === 0) {
      pal.list.append(txt('div', 'hv-dim', 'НЕТ КАНДИДАТОВ — ПОРТСКАН [1] РАСКРОЕТ СЕТЬ'))
    } else if (cands.length > MAX_SHOWN) {
      pal.list.append(txt('div', 'hv-pal-more', `+${cands.length - MAX_SHOWN} …`))
    }
  }

  /** Tab/↑↓: цикл по кандидатам; первый выбор дописывает токен в строку. */
  private paletteCycle(dir: 1 | -1): void {
    const pal = this.palette
    if (pal === null || this.paletteCands.length === 0) return
    const len = this.paletteCands.length
    this.paletteSel = this.paletteSel < 0 ? 0 : (this.paletteSel + dir + len) % len
    const c = this.paletteCands[this.paletteSel]
    const tokens = pal.input.value.trim().split(/\s+/).filter((t) => t !== '')
    if (this.paletteTok === 0) {
      // устройство дополняем с пробелом — следующий Tab дополнит программу
      pal.input.value = c.kind === 'dev' ? `${c.text} ` : c.text
    } else {
      pal.input.value = `${tokens[0] ?? ''} ${c.text}`
    }
    pal.input.setSelectionRange(pal.input.value.length, pal.input.value.length)
    // Программная правка строки не бросает input-событие, поэтому выделение
    // не сбрасывается — updatePalette просто перерисует список с ним.
    this.updatePalette()
  }

  private recallHistory(): void {
    const pal = this.palette
    if (pal === null || this.cmdHistory.length === 0) return
    const i = Math.min(this.histIdx, this.cmdHistory.length - 1)
    pal.input.value = this.cmdHistory[this.cmdHistory.length - 1 - i]
    this.histIdx = i + 1
    this.paletteSel = -1
    this.updatePalette()
  }

  /** Enter: запуск программы с до-поленной целью; кандидат-устройство без
   *  программы — выбор цели, палитра остаётся (§13.3). */
  private paletteRun(): void {
    const pal = this.palette
    if (pal === null) return
    const raw = pal.input.value.trim()
    const tokens = raw.split(/\s+/).filter((t) => t !== '')
    const sel =
      this.paletteSel >= 0 && this.paletteSel < this.paletteCands.length
        ? this.paletteCands[this.paletteSel]
        : undefined
    // Цель: выделенный кандидат-устройство, иначе уникальное/точное
    // совпадение первого токена.
    let dev: string | null = null
    if (sel !== undefined && sel.kind === 'dev' && sel.dev !== undefined) {
      dev = sel.dev
    } else if (tokens.length > 0) {
      const m = [...this.devices.values()].filter((d) => this.devMatch(d, tokens[0].toLowerCase()))
      dev = m.length === 1 ? m[0].id : (m.find((d) => d.id === tokens[0].toLowerCase())?.id ?? null)
    }
    // Программа: выделенный кандидат-программа, иначе фильтр по токену.
    let pq = tokens.length > 1 ? tokens[1] : (tokens[0] ?? '')
    if (sel !== undefined && sel.kind === 'prog' && sel.prog !== undefined) pq = sel.prog
    const progs = PALETTE_PROGS.filter((p) => p.includes(pq.toLowerCase()))
    const prog = progs.find((p) => p === pq.toLowerCase()) ?? progs[0]
    if (prog === undefined) {
      // Программы нет, но устройство есть и оно ещё не в строке как цель —
      // выбираем цель и остаёмся в палитре (пользователь введёт программу).
      if (dev !== null && tokens.length <= 1) {
        this.target = dev
        pal.input.value = `${dev} `
        this.paletteSel = -1
        this.updatePalette()
        this.schedule(() => this.render())
        return
      }
      this.toast('НЕТ ТАКОЙ ПРОГРАММЫ — TAB ПОКАЖЕТ СПИСОК')
      return
    }
    if (this.cmdHistory[this.cmdHistory.length - 1] !== raw && raw !== '') {
      this.cmdHistory.push(raw)
      if (this.cmdHistory.length > 20) this.cmdHistory.shift()
    }
    this.histIdx = 0
    this.closePalette()
    this.runProgAt(prog, dev)
  }

  private push(key: 'cpu' | 'npu' | 'ram' | 'net', v: number): void {
    const a = this.hist[key]
    a.push(Math.max(0, v))
    if (a.length > HISTORY_MAX) a.shift()
  }

  // ── отрисовка ───────────────────────────────────────────────────────────

  private tabTitle(tab: Tab): string {
    if (tab.dev === null) return 'ДЕКА'
    const d = this.devices.get(tab.dev)
    return `${tab.dev.toUpperCase()} ${d !== undefined ? KIND_LABEL[d.kind] : ''}`.trim()
  }

  private ownerLabel(owner: number | null): string {
    if (owner === null) return 'НЕЙТРАЛЬНО'
    if (owner === this.myId) return 'ВЫ'
    return `ИГРОК #${owner}`
  }

  private ownerColor(owner: number | null): string {
    if (owner === null) return '#7d8f85' // нейтральный серый
    if (owner === this.myId) return '#37ff9b'
    return this.deps.teamOf(owner) === 1 ? '#ff4dd2' : '#37ff9b'
  }

  /** Firewall чей (§13.5): свой / союзный / чужой — подпись бейджа. */
  private fwLabel(by: number): string {
    if (by === this.myId) return 'СВОЙ'
    const myTeam = this.myId !== null ? this.deps.teamOf(this.myId) : null
    return myTeam !== null && this.deps.teamOf(by) === myTeam ? 'СОЮЗНИК' : `ВРАГ #${by}`
  }

  /** Цвет бейджа/ореола firewall (§13.5): свой/союзный голубой, чужой маджента. */
  private fwColor(by: number): string {
    if (by === this.myId) return '#5fd7ff'
    const myTeam = this.myId !== null ? this.deps.teamOf(this.myId) : null
    return myTeam !== null && this.deps.teamOf(by) === myTeam ? '#5fd7ff' : '#ff4dd2'
  }

  private render(): void {
    if (!this._active) return
    this.sparkRefs = []
    this.progLists = []
    this.netmapBoxes = []
    this.doorRefs = []
    const main = this.main
    main.replaceChildren()

    const head = el('div', 'hv-head')
    const hostLabel =
      this.host !== '' ? ` // ${KIND_LABEL[this.hostKind ?? 'terminal']} ${this.host.toUpperCase()}` : ''
    head.append(txt('span', 'hv-title', 'HACKDECK'))
    head.append(txt('span', 'hv-host', hostLabel))
    head.append(txt('span', 'hv-net', `NET: ${this.netMbps} МБИТ`))
    head.append(txt('span', 'hv-exit', 'ВЫХОД: CTRL/CMD+ALT+DEL'))
    main.append(head)

    const bar = el('div', 'hv-tabs')
    this.tabs.forEach((tab, i) => {
      const chip = el('button', 'hv-chip')
      if (this.panes.some((p) => p.tabKey === tab.key)) chip.classList.add('on')
      chip.textContent = i === 0 ? 'F1 ДЕКА' : `F${i + 1} ${this.tabTitle(tab)}`
      chip.addEventListener('click', () => {
        this.panes[this.activePane].tabKey = tab.key
        this.schedule(() => this.render())
      })
      bar.append(chip)
    })
    const plus = el('button', 'hv-chip hv-plus')
    plus.textContent = '+ ТАБ'
    plus.addEventListener('click', () => {
      this.menuOpen = !this.menuOpen
      this.schedule(() => this.render())
    })
    bar.append(plus)
    main.append(bar)

    const grid = el('div', `hv-grid ${gridClass(this.panes.length, this.splitDir)}`)
    this.panes.forEach((pane, i) => grid.append(this.buildPane(pane, i)))
    main.append(grid)

    const foot = el('div', 'hv-foot')
    foot.textContent =
      'T ТАБ · W ЗАКРЫТЬ · ЦИФРЫ / F1..F9 ПЕРЕКЛЮЧИТЬ · H/V СПЛИТ · / ПАЛИТРА · CTRL+ALT+DEL ДЖЕК-АУТ'
    main.append(foot)

    if (this.menuOpen) main.append(this.buildMenu())

    this.updateDeckData()
    this.updateDoorStates()
    this.updateNetmaps()
    this.updateCamFeeds()
  }

  private buildPane(pane: Pane, index: number): HTMLElement {
    const tab = this.tabs.find((t) => t.key === pane.tabKey) ?? this.tabs[0]
    const box = el('div', 'hv-pane' + (index === this.activePane ? ' active' : ''))
    box.addEventListener('mousedown', () => this.activatePane(index))
    const head = el('div', 'pane-head')
    head.append(txt('span', 'pane-title', this.tabTitle(tab)))
    if (this.panes.length > 1) {
      const x = el('button', 'pane-x')
      x.textContent = '×'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        this.removePane(index)
      })
      head.append(x)
    }
    const body = el('div', 'pane-body')
    if (tab.dev === null) this.buildDeckPane(body)
    else this.buildDevicePane(body, tab.dev)
    box.append(head, body)
    return box
  }

  private buildDeckPane(body: HTMLElement): void {
    const left = el('div', 'deck-left')

    const sparks = el('div', 'hv-sparks')
    sparks.append(this.buildSpark('cpu', 'CPU'))
    sparks.append(this.buildSpark('npu', 'NPU'))
    sparks.append(this.buildSpark('ram', 'RAM'))
    sparks.append(this.buildSpark('net', 'NET'))
    left.append(sparks)

    const progsBox = el('div', 'hv-progs')
    this.progLists.push(progsBox)
    left.append(progsBox)

    const run = el('div', 'hv-run')
    for (const [label, prog] of [
      ['1 ПОРТСКАН', 'portscan'],
      ['2 VULNSCAN', 'vulnscan'],
      ['3 ТРОЯН', 'trojan'],
      ['4 WATCHER', 'watcher'],
      ['5 FIREWALL', 'firewall'],
      ['6 ANTIVIRUS', 'antivirus'],
    ] as const) {
      const b = el('button', 'hv-btn')
      b.textContent = label + this.targetSuffix()
      b.addEventListener('click', () => this.runProg(prog))
      run.append(b)
    }
    left.append(run)

    const right = el('div', 'deck-right')
    const netmapBox = el('div', 'hv-netmap')
    this.netmapBoxes.push(netmapBox)
    right.append(netmapBox)
    right.append(txt('div', 'netmap-hint', 'КЛИК ПО УЗЛУ — ВЫБОР ЦЕЛИ СКАНА'))

    body.append(left, right)
  }

  private targetSuffix(): string {
    return this.target !== null ? ` → ${this.target.toUpperCase()}` : ' → ЦЕЛЬ?'
  }

  private buildSpark(key: SparkRef['key'], label: string): HTMLElement {
    const wrap = el('div', 'spark')
    const top = el('div', 'spark-top')
    top.append(txt('span', 'spark-label', label))
    const value = txt('span', 'spark-value', '—')
    top.append(value)
    const canvas = el('canvas')
    canvas.className = 'spark-cv'
    canvas.style.width = `${SPARK_W}px`
    canvas.style.height = `${SPARK_H}px`
    wrap.append(top, canvas)
    this.sparkRefs.push({ canvas, value, key })
    return wrap
  }

  private buildDevicePane(body: HTMLElement, dev: string): void {
    const d = this.devices.get(dev)
    if (d === undefined) {
      body.append(txt('div', 'hv-dim', `${dev.toUpperCase()} БОЛЬШЕ НЕ В СЕТИ — ПЕРЕСКАН [1]`))
      return
    }
    if (d.kind === 'door') {
      const wrap = el('div', 'door-ui')
      const status = el('div', 'door-status')
      wrap.append(status)
      wrap.append(txt('div', 'door-owner', `ВЛАДЕЛЕЦ: ${this.ownerLabel(d.owner)}`))
      const btn = el('button', 'hv-btn door-toggle')
      btn.textContent = 'TOGGLE'
      btn.disabled = d.owner !== this.myId // ctrl валидирует сервер, это только UX
      btn.addEventListener('click', () => this.deps.send({ t: 'ctrl', dev, action: 'toggle' }))
      wrap.append(btn)
      if (d.owner !== this.myId) {
        wrap.append(txt('div', 'hv-dim', 'НУЖЕН TROJAN: НА ДЕКЕ [2] VULNSCAN → [3] ТРОЯН'))
      }
      body.append(wrap)
      this.doorRefs.push({ dev, status, btn })
      return
    }
    if (d.kind === 'camera') {
      // §13.7: сенсор — «картинка в UI» это лента наблюдения (видео — M7+).
      // Плейтест M3: лента = «рапорт» — шапка (id/статус/T+/цели) + строки-
      // профили целей; пустой кадр — осмысленный стейт «СЕКТОР ЧИСТ».
      const wrap = el('div', 'cam-ui')
      wrap.append(txt('div', 'cam-owner', `ВЛАДЕЛЕЦ: ${this.ownerLabel(d.owner)} · РАДИУС 12 М + LOS`))
      if (d.owner === this.myId) {
        const report = el('div', 'cam-report')
        const head = el('div', 'cam-report-head')
        const id = txt('span', 'cam-report-id', dev.toUpperCase())
        head.append(id)
        head.append(txt('span', 'cam-report-status', 'ЗАХВАЧЕНА'))
        const time = txt('span', 'cam-report-time', 'T+00:00')
        head.append(time)
        const count = txt('span', 'cam-report-count', 'ЦЕЛЕЙ: 0')
        head.append(count)
        report.append(head)
        const list = el('div', 'cam-feed')
        report.append(list)
        wrap.append(report)
        this.camRefs.push({ dev, list, time, count })
      } else {
        wrap.append(txt('div', 'hv-dim', 'НУЖЕН TROJAN: НА ДЕКЕ [2] VULNSCAN → [3] ТРОЯН'))
      }
      body.append(wrap)
      return
    }
    const info = el('div', 'dev-info')
    const row = (k: string, v: string): void => {
      const r = el('div', 'dev-row')
      r.append(txt('span', 'dev-k', k), txt('span', 'dev-v', v))
      info.append(r)
    }
    row('ID', d.id.toUpperCase())
    row('ТИП', KIND_LABEL[d.kind])
    row('ВЛАДЕЛЕЦ', this.ownerLabel(d.owner))
    row('СВЯЗИ', d.links.map((l) => l.toUpperCase()).join(' ') || '—')
    info.append(txt('div', 'hv-dim', 'КОНТРОЛЛЕРОВ НЕТ — ЗАГЛУШКА M2'))
    body.append(info)
  }

  private buildMenu(): HTMLElement {
    const wrap = el('div', 'hv-menu-wrap')
    wrap.addEventListener('mousedown', () => {
      this.menuOpen = false
      this.schedule(() => this.render())
    })
    const menu = el('div', 'hv-menu')
    menu.addEventListener('mousedown', (e) => e.stopPropagation())
    menu.append(txt('div', 'menu-title', 'НОВЫЙ ТАБ — ВЫБЕРИ УСТРОЙСТВО'))
    const devs = [...this.devices.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    if (devs.length === 0) {
      menu.append(txt('div', 'hv-dim', 'НЕТ ДАННЫХ — ЗАПУСТИ ПОРТСКАН [1]'))
    }
    for (const d of devs) {
      const b = el('button', 'menu-dev')
      b.addEventListener('click', () => {
        this.menuOpen = false
        this.ensureTab(d.id, true)
        this.schedule(() => this.render())
      })
      b.append(txt('span', 'dev-id', `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`))
      const own = txt('span', 'dev-own', this.ownerLabel(d.owner))
      own.style.color = this.ownerColor(d.owner)
      b.append(own)
      menu.append(b)
    }
    wrap.append(menu)
    return wrap
  }

  // ── точечные обновления ─────────────────────────────────────────────────

  private updateDeckData(): void {
    const last = (a: readonly number[]): number => (a.length > 0 ? a[a.length - 1] : 0)
    for (const r of this.sparkRefs) {
      const samples =
        r.key === 'ram'
          ? this.hist.ram.map((v) => (this.deckRam > 0 ? v / this.deckRam : 0))
          : this.hist[r.key]
      drawSpark(r.canvas, samples)
      r.value.textContent =
        r.key === 'ram' ? `${last(this.hist.ram)}/${this.deckRam}` : `${Math.round(last(this.hist[r.key]) * 100)}%`
    }
    for (const list of this.progLists) this.fillProgs(list)
  }

  private fillProgs(list: HTMLElement): void {
    list.replaceChildren()
    if (this.progs.length === 0) {
      list.append(txt('div', 'hv-dim', 'ПРОЦЕССОВ НЕТ — КЛАВИШИ 1/2/3/4/5/6'))
      return
    }
    for (const p of this.progs) {
      const row = el('div', 'hv-prog')
      const name = `${PROG_LABEL[p.prog] ?? p.prog}${p.dev !== null ? ` → ${p.dev.toUpperCase()}` : ''}`
      row.append(txt('span', 'prog-name', `#${p.id} ${name}`))
      row.append(txt('span', 'prog-eta', `${(p.etaMs / 1000).toFixed(1)}с`))
      list.append(row)
    }
  }

  private updateDoorStates(): void {
    for (const ref of this.doorRefs) {
      const open = this.doorOpen.get(ref.dev) ?? false
      ref.status.textContent = open ? 'ОТКРЫТА' : 'ЗАКРЫТА'
      ref.status.classList.toggle('open', open)
      ref.status.classList.toggle('closed', !open)
      // Обрыв кабеля отрезает и управление (контр-хакинг §6): узел без связей
      // = сеть отсечена, тоггл недоступен.
      const dev = this.devices.get(ref.dev)
      const severed = dev !== undefined && dev.links.length === 0
      if (ref.btn !== null) {
        ref.btn.disabled = severed
        ref.btn.title = severed ? 'сеть устройства отсечена' : ''
      }
      ref.status.classList.toggle('severed', severed)
    }
  }

  /** Точечное обновление лент камер (§13.7): без перестройки DOM. Кадр —
   *  «рапорт»: шапка (uptime ленты, счётчик целей) + профиль каждой цели —
   *  дистанция от объектива, азимут и направление движения вычисляются из
   *  данных кадра + позиции камеры из scan (протокол не расширяется). */
  private updateCamFeeds(): void {
    const now = performance.now()
    for (const ref of this.camRefs) {
      const seen = this.camFeeds.get(ref.dev)
      const cam = this.devices.get(ref.dev)
      // uptime ленты T+мм:сс — от первого кадра (владение могло случиться
      // вне деки; это uptime наблюдения, а не владения — честное число)
      const t0 = this.camFirstFrame.get(ref.dev)
      if (t0 !== undefined) {
        const sec = Math.max(0, Math.floor((now - t0) / 1000))
        ref.time.textContent = `T+${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
      }
      ref.count.textContent = `ЦЕЛЕЙ: ${seen?.length ?? 0}`
      ref.list.replaceChildren()
      if (seen === undefined) {
        ref.list.append(txt('div', 'cam-empty', 'ОЖИДАНИЕ КАДРА…'))
        continue
      }
      if (seen.length === 0) {
        ref.list.append(txt('div', 'cam-empty-title', 'СЕКТОР ЧИСТ'))
        const last = this.camLastContact.get(ref.dev)
        const lastText =
          last !== undefined
            ? `ПОСЛЕДНИЙ КОНТАКТ: ${last.name.toUpperCase()}, ${Math.max(1, Math.round((now - last.at) / 1000))} С НАЗАД`
            : 'КОНТАКТОВ НЕ БЫЛО'
        ref.list.append(txt('div', 'cam-empty-sub', `КАДР 2 Гц · ${lastText}`))
        continue
      }
      const prev = this.camPrevFrame.get(ref.dev)
      for (const s of seen) {
        ref.list.append(this.buildCamRow(s, cam, prev?.get(s.id)))
      }
    }
    // кадр обработан → он же теперь «предыдущий» для дельт движения
    for (const [dev, seen] of this.camFeeds) {
      const m = new Map<number, CamSeen>()
      for (const s of seen) m.set(s.id, s)
      this.camPrevFrame.set(dev, m)
    }
  }

  /** Строка-«профиль» цели: имя цветом команды, класс, дистанция до
   *  объектива (3D, как радиус 12 м на сервере), азимут от камеры и сектор
   *  движения (Δ между кадрами; стоит на месте — «·»). */
  private buildCamRow(s: CamSeen, cam: ScanDevice | undefined, prev: CamSeen | undefined): HTMLElement {
    const row = el('div', 'cam-row')
    const name = txt('span', 'cam-name', s.name)
    name.style.color = s.team === 1 ? '#ff4dd2' : '#37ff9b'
    row.append(name)
    row.append(txt('span', 'cam-cls', s.cls.toUpperCase()))
    if (cam !== undefined) {
      // центр корпуса игрока = ноги + 0.9 м (та же точка, куда смотрит LOS)
      const dx = s.x - cam.x
      const dy = s.y + 0.9 - cam.y
      const dz = s.z - cam.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      row.append(txt('span', 'cam-metric', `${dist.toFixed(1)} М`))
      const az = (Math.atan2(dx, -dz) * 180) / Math.PI
      row.append(txt('span', 'cam-metric', `АЗ ${String(Math.round((az + 360) % 360)).padStart(3, '0')}°`))
    } else {
      row.append(txt('span', 'cam-metric', '—'))
    }
    row.append(txt('span', 'cam-move', this.moveSector(s, prev)))
    return row
  }

  /** Сектор направления движения из Δ двух кадров (2 Гц); север = −Z. */
  private moveSector(s: CamSeen, prev: CamSeen | undefined): string {
    if (prev === undefined) return '·'
    const dx = s.x - prev.x
    const dz = s.z - prev.z
    if (dx * dx + dz * dz < 0.09) return '·' // < 0.3 м между кадрами — стоит
    const a = Math.atan2(dx, -dz) // −π..π, 0 = север
    const i = Math.round(a / (Math.PI / 4))
    return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][(i + 8) % 8]
  }

  private updateNetmaps(): void {
    for (const box of this.netmapBoxes) {
      box.replaceChildren()
      box.append(this.buildNetmapSvg())
    }
  }

  /** SVG-карта сети: узлы = discovered устройства, цвет = владелец, клик = цель. */
  private buildNetmapSvg(): SVGElement {
    const W = 340
    const H = 250
    const PAD = 30
    const svg = svgEl('svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.classList.add('netmap-svg')

    const nodes = [...this.devices.values()]
    const label = (x: number, y: number, text: string, cls: string): void => {
      const t = svgEl('text')
      t.setAttribute('x', String(x))
      t.setAttribute('y', String(y))
      t.setAttribute('text-anchor', 'middle')
      t.classList.add(cls)
      t.textContent = text
      svg.append(t)
    }
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string): void => {
      const l = svgEl('line')
      l.setAttribute('x1', String(x1))
      l.setAttribute('y1', String(y1))
      l.setAttribute('x2', String(x2))
      l.setAttribute('y2', String(y2))
      // setAttribute, не classList.add: у SVG-элементов classList.add с
      // multi-token строкой ('a b') бросает InvalidCharacterError и рендер
      // карты умирает целиком.
      l.setAttribute('class', cls)
      svg.append(l)
    }

    if (nodes.length === 0) {
      label(W / 2, H / 2, 'ТУМАН ВОЙНЫ — ПОРТСКАН [1]', 'svg-dim')
      return svg
    }

    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let minZ = Number.POSITIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    for (const d of nodes) {
      minX = Math.min(minX, d.x)
      maxX = Math.max(maxX, d.x)
      minZ = Math.min(minZ, d.z)
      maxZ = Math.max(maxZ, d.z)
    }
    const spanX = Math.max(maxX - minX, 1)
    const spanZ = Math.max(maxZ - minZ, 1)
    const k = Math.min((W - PAD * 2) / spanX, (H - PAD * 2 - 20) / spanZ)
    const offX = (W - PAD * 2 - spanX * k) / 2
    const offZ = (H - PAD * 2 - 20 - spanZ * k) / 2
    const px = (x: number): number => PAD + offX + (x - minX) * k
    const py = (z: number): number => PAD + 10 + offZ + (z - minZ) * k

    // связи (дедуп по паре)
    const seen = new Set<string>()
    const drawLink = (a: ScanDevice, b: ScanDevice): void => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      if (seen.has(key)) return
      seen.add(key)
      const wireless = a.kind === 'radio' || b.kind === 'radio'
      line(px(a.x), py(a.z), px(b.x), py(b.z), wireless ? 'svg-link svg-wireless' : 'svg-link')
    }
    for (const d of nodes) {
      for (const l of d.links) {
        const o = this.devices.get(l)
        if (o !== undefined) drawLink(d, o)
      }
    }

    // дека — узел в углу, линией к точке джек-ина
    const deckX = 22
    const deckY = 22
    const hostDev = this.devices.get(this.host)
    if (hostDev !== undefined) line(deckX, deckY, px(hostDev.x), py(hostDev.z), 'svg-link svg-link-deck')
    const deck = svgEl('circle')
    deck.setAttribute('cx', String(deckX))
    deck.setAttribute('cy', String(deckY))
    deck.setAttribute('r', '6')
    deck.classList.add('svg-deck')
    svg.append(deck)
    label(deckX, deckY + 18, 'ДЕКА', 'svg-label')

    // устройства
    for (const d of nodes) {
      const cx = px(d.x)
      const cy = py(d.z)
      if (d.id === this.target) {
        const ring = svgEl('circle')
        ring.setAttribute('cx', String(cx))
        ring.setAttribute('cy', String(cy))
        ring.setAttribute('r', '11')
        ring.classList.add('svg-sel')
        svg.append(ring)
      }
      if (d.vulned === true) {
        const vm = svgEl('circle')
        vm.setAttribute('cx', String(cx))
        vm.setAttribute('cy', String(cy))
        vm.setAttribute('r', '10')
        vm.classList.add('svg-vulned')
        svg.append(vm)
      }
      // Мой watcher на устройстве — янтарный пунктирный ореол (§13.1).
      if (d.watched === true) {
        const wt = svgEl('circle')
        wt.setAttribute('cx', String(cx))
        wt.setAttribute('cy', String(cy))
        wt.setAttribute('r', '10')
        wt.classList.add('svg-watched')
        svg.append(wt)
      }
      // Firewall на устройстве (§13.5): пунктирный ореол + бейдж «FW» —
      // цвет по firewalledBy (свой/союзный голубой, чужой маджента), чей —
      // в tooltip. Рёбра за чужим фильтром не рисуются: устройства за ним
      // выпадают из скана (сегмент визуально отсечён).
      if (d.firewalled === true) {
        const by = d.firewalledBy ?? 0
        const fw = svgEl('circle')
        fw.setAttribute('cx', String(cx))
        fw.setAttribute('cy', String(cy))
        fw.setAttribute('r', '15')
        fw.setAttribute('stroke', this.fwColor(by))
        fw.classList.add('svg-firewalled')
        svg.append(fw)
        const badge = svgEl('text')
        badge.setAttribute('x', String(cx))
        badge.setAttribute('y', String(cy - 19))
        badge.setAttribute('text-anchor', 'middle')
        badge.setAttribute('fill', this.fwColor(by))
        badge.setAttribute('font-size', '7')
        badge.classList.add('svg-fwbadge')
        badge.textContent = `FW ${this.fwLabel(by)}`
        svg.append(badge)
      }
      // Antivirus на устройстве (чей — не важно: резидентный процесс
      // наблюдаем из сети, §13.6) — фиолетовый пунктирный ореол.
      if (d.antivirused === true) {
        const av = svgEl('circle')
        av.setAttribute('cx', String(cx))
        av.setAttribute('cy', String(cy))
        av.setAttribute('r', '12')
        av.classList.add('svg-antivirused')
        svg.append(av)
      }
      // Захваченное устройство: жирное кольцо цвета команды владельца —
      // «это уже моё/ихнее» видно с первого взгляда (плейтест M2).
      if (d.owner !== null) {
        const own = svgEl('circle')
        own.setAttribute('cx', String(cx))
        own.setAttribute('cy', String(cy))
        own.setAttribute('r', '13')
        own.setAttribute('stroke', this.ownerColor(d.owner))
        own.setAttribute('stroke-width', d.owner === this.myId ? '3' : '2')
        own.setAttribute('fill', 'none')
        own.classList.add('svg-owned')
        svg.append(own)
      }
      const c = svgEl('circle')
      c.setAttribute('cx', String(cx))
      c.setAttribute('cy', String(cy))
      c.setAttribute('r', '7')
      c.setAttribute('fill', this.ownerColor(d.owner))
      c.classList.add('svg-node')
      c.addEventListener('click', () => {
        this.target = d.id
        this.schedule(() => this.render())
      })
      svg.append(c)
      const title = svgEl('title')
      title.textContent = `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`
      c.append(title)
      label(cx, cy + 19, d.id.toUpperCase(), 'svg-label')
    }
    return svg
  }
}
