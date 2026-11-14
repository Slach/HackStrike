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
  firewall: 'FIREWALL — ДОСТУП ЗАПРЕЩЁН',
  bad_target: 'FIREWALL — ТОЛЬКО ТЕРМИНАЛ ИЛИ РАДИО',
  antivirus: 'ANTIVIRUS — УСТАНОВКА TROJAN ОТБИТА',
}

const KIND_LABEL: Readonly<Record<PropKind, string>> = {
  terminal: 'ТЕРМИНАЛ',
  radio: 'РАДИО-ТОЧКА',
  switch: 'SWITCH',
  door: 'ДВЕРЬ',
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
  /** Устройства с чьим-то firewall (M3 §13.5) — ореол + тост об установке. */
  private firewalled = new Map<string, true>()
  /** Устройства с чьим-то antivirus (M3 §13.6) — ореол + тост об установке. */
  private antivirused = new Map<string, true>()
  private tabs: Tab[] = [{ key: 'deck', dev: null }]
  private panes: Pane[] = [{ tabKey: 'deck' }]
  private activePane = 0
  private splitDir: 'h' | 'v' = 'h'
  private menuOpen = false

  // Refs для точечных обновлений без перестройки DOM (клики не срываются).
  private sparkRefs: SparkRef[] = []
  private progLists: HTMLElement[] = []
  private netmapBoxes: HTMLElement[] = []
  private doorRefs: { dev: string; status: HTMLElement; btn: HTMLButtonElement }[] = []

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
    // Обратная связь firewall (§13.5): фильтр на карте видим всем скавшим.
    for (const d of msg.devices) {
      if (d.firewalled === true && !this.firewalled.has(d.id)) {
        this.toast(`FIREWALL: ${d.id.toUpperCase()}`)
      }
    }
    this.firewalled = new Map([...next].filter(([, d]) => d.firewalled === true).map(([id]) => [id, true] as const))
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
    const needDev = prog !== 'portscan'
    if (needDev && this.target === null) {
      this.toast('ВЫБЕРИТЕ ЦЕЛЬ НА КАРТЕ СЕТИ')
      return
    }
    const devSuffix = needDev && this.target !== null ? ` → ${this.target.toUpperCase()}` : ''
    this.deps.send(
      needDev && this.target !== null ? { t: 'run', prog, dev: this.target } : { t: 'run', prog },
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
      'T ТАБ · W ЗАКРЫТЬ · ЦИФРЫ / F1..F9 ПЕРЕКЛЮЧИТЬ · H/V СПЛИТ · ESC ВЫХОД'
    main.append(foot)

    if (this.menuOpen) main.append(this.buildMenu())

    this.updateDeckData()
    this.updateDoorStates()
    this.updateNetmaps()
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
      // Firewall на устройстве (чей — не важно: фильтр наблюдаем из сети,
      // §13.5) — голубой пунктирный ореол по аналогии со watched.
      if (d.firewalled === true) {
        const fw = svgEl('circle')
        fw.setAttribute('cx', String(cx))
        fw.setAttribute('cy', String(cy))
        fw.setAttribute('r', '15')
        fw.classList.add('svg-firewalled')
        svg.append(fw)
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
