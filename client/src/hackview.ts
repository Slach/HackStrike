// Hacker view (M2, GDD §12.6): full-screen DOM overlay in CRT-terminal
// style, visible between "jackin" and "jackout"/death. Tiled WM of panels:
// F1 = deck, F2+ = controlled devices; plain T new tab, W close, H/V split
// (up to 2×2), F1..F9 switch (modifier variants are reserved by the browser
// and never reach the page — GDD §12.1/§12.6). The server stays the single
// source of truth — this UI only renders deck/scan/snap data and sends
// run/ctrl intents.
//
// Rendering split: render() rebuilds the structure (rare — tab/pane/scan
// changes); deck samples (2 Hz) and door states update existing nodes in
// place, so a pending button click is never swallowed by a re-render.

import { IS_TOUCH } from './mobile'
import type {
  CamSeen,
  ClientMessage,
  DeckProg,
  LogEntry,
  CyberKind,
  PropKind,
  RadarWho,
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
type RadarMsg = Extract<ServerMessage, { t: 'radar' }>

export interface HackViewDeps {
  send: (msg: ClientMessage) => void
  teamOf: (playerId: number) => number | null
  /** Имя игрока по id (для журнала событий watcher'а, §13.1 №1); null — неизвестен. */
  nameOf: (playerId: number) => string | null
  /** Джек-аут по тапу на touch (ГДД §15.2): на телефоне Ctrl/Cmd+ALT+DEL
   *  физически недоступен, кнопка ВЫХОД в шапке дека — его touch-эквивалент. */
  jackout: () => void
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

// Только сетевые устройства: лава (M4 §14.6) — не девайс, в деку не попадает,
// поэтому в словаре её подписи нет (тип CyberKind это и сторожит).
const KIND_LABEL: Readonly<Record<CyberKind, string>> = {
  terminal: 'ТЕРМИНАЛ',
  radio: 'РАДИО-ТОЧКА',
  switch: 'SWITCH',
  door: 'ДВЕРЬ',
  camera: 'КАМЕРА',
  cable: 'КАБЕЛЬ',
  gas: 'ГАЗ',
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
  gas: 'gas', // M4 §14.2: фильтр палитры по kind и по-русски
  газ: 'gas',
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
  /** Базовый viewBox SVG-карты сети (плейтест M3: 480×360 — больше воздуха
   *  между узлами, было 340×250). Зум/пан считаются от него. */
  private static readonly NETMAP_W = 480
  private static readonly NETMAP_H = 360

  private readonly root: HTMLElement
  private readonly main: HTMLElement
  private readonly toasts: HTMLElement
  private raf: number | null = null
  private pendingJobs: (() => void)[] = []
  private _active = false

  private myId: number | null = null
  private host = ''
  private hostKind: CyberKind | null = null
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
  /** open-состояния дверей и газовых клапанов из снапа (M4: общий механизм). */
  private readonly valveOpen = new Map<string, boolean>()
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
  /** Радар-срезы watcher'а (M3 §13.1 №3): последний срез по каждому МОЕМУ
   *  watched-устройству; живёт между перестройками DOM, обновление на месте. */
  private readonly radarFeeds = new Map<string, readonly RadarWho[]>()
  private tabs: Tab[] = [{ key: 'deck', dev: null }]
  private panes: Pane[] = [{ tabKey: 'deck' }]
  private activePane = 0
  private splitDir: 'h' | 'v' = 'h'
  /** Мышиное меню «+ ТАБ» (клик по чипу); клавиатурный T — палитра, §12.6. */
  private menuOpen = false
  /** Режим палитры: 'run' = '/' программы, 'tab' = 'T' открыть таб (§12.6). */
  private paletteMode: 'run' | 'tab' = 'run'

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
  /** Табы управляемых устройств (двери + газовые клапаны): точечное обновление
   *  статуса/кнопки без перестройки DOM. kind нужен для подписи статуса. */
  private doorRefs: { dev: string; kind: 'door' | 'gas'; status: HTMLElement; btn: HTMLButtonElement }[] = []
  private camRefs: { dev: string; list: HTMLElement; time: HTMLElement; count: HTMLElement }[] = []
  private radarRefs: { dev: string; list: HTMLElement; count: HTMLElement }[] = []

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

  activate(msg: JackinMsg, hostKind: CyberKind | null): void {
    this._active = true
    this.host = msg.host
    this.hostKind = hostKind
    this.netMbps = msg.deck.net
    this.deckRam = msg.deck.ram > 0 ? msg.deck.ram : 4
    this.progs = []
    // Дедупликаторы тостов-«находок» живут в синглтоне страницы и переживали
    // смерть/реконнект: повторный vulnscan той же цели приходил как «не новое»
    // и тост «УЯЗВИМОСТЬ НАЙДЕНА» глох — выглядело «vulnscan не находит»
    // (баг-репорт владельца 2026-11-15; сервер флаг ставит «навсегда», §12.4).
    // Каждая сессия деки заново анонсирует стоящие флаги после portscan.
    this.vulned = new Map()
    this.watched = new Map()
    this.firewalled = new Map()
    this.antivirused = new Map()
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
    this.netmapZoom = 1 // зум/пан карты не переживает сессию деки
    this.netmapCenter = { x: HackView.NETMAP_W / 2, y: HackView.NETMAP_H / 2 }
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
    this.radarRefs = []
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
        this.toast(`УЯЗВИМОСТЬ НАЙДЕНА: ${d.id.toUpperCase()} — TROJAN [3]`)
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
      // §13.1: watcher'а на устройстве больше нет (у меня) — радар-срез гаснет;
      // журнал живёт на устройстве, данные приходят прямо в scan.devices[].log.
      if (d.watched !== true) this.radarFeeds.delete(id)
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

  /** Радар-срез watcher'а (M3 §13.1 №3): 1 Гц по моему watched-устройству.
   *  Храним даже вне hackview — открыв таб, хакер видит срез сразу. */
  onRadar(msg: RadarMsg): void {
    this.radarFeeds.set(msg.dev, msg.who)
    this.schedule(() => this.updateRadar())
  }

  /** Состояние дверей/газовых клапанов из snap.props (без перестройки DOM). */
  updateProps(props: readonly SnapProp[]): void {
    let changed = false
    for (const p of props) {
      // газ (M4 §14.2) — то же поле open («клапан открыт»), тот же таб-панель
      if ((p.kind !== 'door' && p.kind !== 'gas') || p.open === undefined) continue
      if (this.valveOpen.get(p.id) !== p.open) {
        this.valveOpen.set(p.id, p.open)
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
    // Автоповтор не исполняем: удержание plain W закрывало бы табы один за
    // другим, удержание Space — спамил бы TOGGLE двери, Enter в палитре —
    // перезапускал программы. Редактирование текста в палитре не страдает:
    // там повтор — дефолт браузера, а не наш обработчик.
    if (e.repeat) return
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
    // Мышино меню «+ ТАБ» (клик по чипу) закрывается Escape — палитра для T
    // теперь основной клавиатурный путь, но жест для мыши остаётся.
    if (e.code === 'Escape' && this.menuOpen) {
      e.preventDefault()
      this.menuOpen = false
      this.schedule(() => this.render())
      return
    }
    // WM-хоткеи — PLAIN T/W/H/V (ГДД §12.1/§12.6, плейтест M3): Cmd/Ctrl+T/W
    // резервирует браузер (новая вкладка / закрытие вкладки), до страницы не
    // доходят — поэтому модификаторный вариант был мёртв физически. Plain W/H/V
    // не конфликтуют с FPS-управлением: в деке controls.frozen, при джек-ауте
    // клавиши сбрасываются (resetKeys). Пробел/цифры палитры — ниже.
    if (!mod && !e.altKey) {
      // T — палитра в режиме «таб»: фильтр устройства + Enter = открыть таб
      // (плейтест M3: «надо можно было T CAM2», как / в режиме программ).
      if (e.code === 'KeyT') {
        e.preventDefault()
        this.openPalette('tab')
        return
      }
      // W — в сплите снимает ПАНЕЛЬ (окно), а не таб: иначе при сплитах
      // «закрыть» не закрывал ничего (панель деки refuse'ила) — плейтест M3.
      if (e.code === 'KeyW') {
        e.preventDefault()
        if (this.panes.length > 1) this.removePane(this.activePane)
        else this.closeActiveTab()
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
    }
    // Ctrl/Cmd+любое (кроме тройки, отобранной выше) — территория браузера:
    // не перехватываем и не исполняем (как раньше: мода не доходит до F/Space/
    // программ ниже).
    if (mod) return
    // Переключение табов — F1..F9. Цифры с Ctrl/Cmd тоже зарезервированы
    // браузером (переключение вкладок), plain-цифры = программы деки ниже.
    const f = keyIndex(e.code, 'F')
    if (f !== null) {
      e.preventDefault() // F1 иначе открывает помощь браузера
      if (f < this.tabs.length) {
        this.panes[this.activePane].tabKey = this.tabs[f].key
        this.schedule(() => this.render())
      }
      return
    }
    // ПРОБЕЛЬ на табе двери-владения = TOGGLE (плейтест M3) — как кнопка,
    // но с клавиатуры. Сервер валидирует ctrl, это только UX. Газ (M4 §14.2)
    // — то же правило: взвод клапана пробелом на своём табе газа.
    if (e.code === 'Space') {
      const pane0 = this.panes[this.activePane]
      const tab0 = this.tabs.find((t) => t.key === pane0?.tabKey)
      const dev0 = tab0?.dev !== null && tab0?.dev !== undefined ? this.devices.get(tab0.dev) : undefined
      if (dev0 !== undefined && (dev0.kind === 'door' || dev0.kind === 'gas') && dev0.owner === this.myId) {
        e.preventDefault()
        this.deps.send({ t: 'ctrl', dev: dev0.id, action: 'toggle' })
      }
      return
    }
    // Палитра программ — из ЛЮБОГО таба, не только деки: после сплита/H/V
    // активная панель могла уехать на устройство, и `/` молчал (плейтест M3).
    // e.code — физическая клавиша: слэш работает в любой раскладке (в русской
    // e.key = '.', а code всё равно 'Slash'). Firefox иначе открывает quick-find.
    if (e.code === 'Slash' && !e.altKey) {
      e.preventDefault()
      this.openPalette('run')
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

  private openPalette(mode: 'run' | 'tab'): void {
    if (this.palette !== null) return
    this.paletteMode = mode
    const wrap = el('div', 'hv-palette')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hv-pal-input'
    input.autocomplete = 'off'
    input.spellcheck = false
    // Enter на экранной клавиатуре = «Поиск» (запуск), не перевод строки (§15.2)
    input.enterKeyHint = 'search'
    input.placeholder =
      mode === 'tab' ? 'фильтр устройства — напр. cam2, ENTER ОТКРЫТЬ ТАБ' : 'фильтр устройства + программа — напр. cam1 port'
    input.addEventListener('input', () => {
      this.paletteSel = -1
      this.updatePalette()
    })
    const list = el('div', 'hv-pal-list')
    const hint = el('div', 'hv-pal-hint')
    hint.textContent = IS_TOUCH
      ? mode === 'tab'
        ? 'ТАП ПО СТРОКЕ — ОТКРЫТЬ ТАБ · × ЗАКРЫТЬ'
        : 'ТАП ПО СТРОКЕ — ЗАПУСК · ENTER ЗАПУСК · × ЗАКРЫТЬ'
      : mode === 'tab'
        ? 'TAB ДОПОЛНИТЬ · ↑↓ ВЫБОР · ENTER ОТКРЫТЬ ТАБ · ESC ЗАКРЫТЬ'
        : 'TAB ДОПОЛНИТЬ · ↑↓ ВЫБОР · ↑ ИСТОРИЯ · ENTER ЗАПУСК · ESC ЗАКРЫТЬ'
    wrap.append(input, list, hint)
    if (IS_TOUCH) {
      // На телефоне ESC нет — кнопка закрытия в строке подсказки (ГДД §15.2).
      const x = el('button', 'hv-pal-x')
      x.textContent = '×'
      x.setAttribute('aria-label', 'закрыть')
      x.addEventListener('click', () => this.closePalette())
      hint.append(x)
    }
    this.root.append(wrap)
    this.palette = { wrap, input, list }
    this.paletteSel = -1
    this.histIdx = 0
    this.updatePalette()
    input.focus()
  }

  private closePalette(): void {
    if (this.palette === null) return
    // Touch: снять фокус, иначе экранная клавиатура останется висеть (§15.2).
    this.palette.input.blur()
    this.palette.wrap.remove()
    this.palette = null
    this.paletteCands = []
    this.paletteSel = -1
  }

  /** Устройство подходит под токен: совпадение по НАЧАЛУ строки в id/kind
   *  (с алиасами term/cam); пустой токен подходит всем (§13.3). Префикс, а
   *  не подстрока — иначе «d1 t» даёт portscan раньше trojan. */
  private devMatch(d: ScanDevice, q: string): boolean {
    if (q === '') return true
    const alias = KIND_ALIAS[q]
    return d.id.startsWith(q) || d.kind.startsWith(q) || (alias !== undefined && d.kind === alias)
  }

  private updatePalette(): void {
    const pal = this.palette
    if (pal === null) return
    const tokens = pal.input.value.trim().split(/\s+/).filter((t) => t !== '')
    const dq = (tokens[0] ?? '').toLowerCase()
    const pq = (tokens[1] ?? '').toLowerCase()
    // Хвостовой пробел после устройства = перешли ко второму токену
    // (иначе «cam1␣» после Tab опять показывает список устройств).
    const secondTok = tokens.length > 1 || /\s$/.test(pal.input.value)
    const cands: PalCand[] = []
    // Режим «таб» (T): только устройства, второго токена нет (§12.6).
    const isTabMode = this.paletteMode === 'tab'
    this.paletteTok = isTabMode ? 0 : secondTok ? 1 : 0
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
          hint: isTabMode ? this.tabHint(d) : this.ownerLabel(d.owner),
        })
      }
      for (const p of PALETTE_PROGS) {
        if (!isTabMode && p.startsWith(dq)) {
          cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint: 'ПРОГРАММА' })
        }
      }
    } else {
      // Второй токен: ВСЕ программы для выбранного устройства, с подсказкой
      // готовности (плейтест M3: «нажал CAM1 + Tab — покажи что можно»).
      const dev = [...this.devices.values()].find((d) => this.devMatch(d, dq))
      for (const p of PALETTE_PROGS) {
        if (!p.startsWith(pq)) continue
        let hint = 'ГОТОВО'
        if (p === 'portscan') hint = 'БЕЗ ЦЕЛИ'
        else if (p === 'trojan' && dev !== undefined && !dev.vulned) hint = 'СНАЧАЛА VULNSCAN'
        cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint })
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
      if (IS_TOUCH) {
        // Тап по кандидату = тот же Enter (ГДД §15.2): выделение ставим на него
        // и запускаем — на телефоне Tab/↑↓ недоступны.
        row.addEventListener('click', () => {
          this.paletteSel = i
          this.paletteRun()
        })
      }
      pal.list.append(row)
    })
    if (cands.length === 0) {
      pal.list.append(txt('div', 'hv-dim', 'НЕТ КАНДИДАТОВ — PORTSCAN [1] РАСКРОЕТ СЕТЬ'))
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
    if (this.paletteMode === 'tab') {
      pal.input.value = c.text // без хвостового пробела: второго токена нет
    } else if (this.paletteTok === 0) {
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
    // История команд — только про запуск программ; в режиме «таб» там чужие
    // строки («portscan»), они только собьют с толку.
    if (pal === null || this.paletteMode === 'tab' || this.cmdHistory.length === 0) return
    const i = Math.min(this.histIdx, this.cmdHistory.length - 1)
    pal.input.value = this.cmdHistory[this.cmdHistory.length - 1 - i]
    this.histIdx = i + 1
    this.paletteSel = -1
    this.updatePalette()
  }

  /** Подсказка кандидата в режиме «таб» (T): владелец или «УЖЕ В ТАБАХ». */
  private tabHint(d: ScanDevice): string {
    return this.tabs.some((t) => t.dev === d.id) ? 'УЖЕ В ТАБАХ' : this.ownerLabel(d.owner)
  }

  /** Enter: запуск программы с до-поленной целью; кандидат-устройство без
   *  программы — выбор цели, палитра остаётся (§13.3). В режиме «таб» —
   *  открыть таб на устройство (§12.6). */
  private paletteRun(): void {
    const pal = this.palette
    if (pal === null) return
    const raw = pal.input.value.trim()
    const tokens = raw.split(/\s+/).filter((t) => t !== '')
    const sel =
      this.paletteSel >= 0 && this.paletteSel < this.paletteCands.length
        ? this.paletteCands[this.paletteSel]
        : undefined
    if (this.paletteMode === 'tab') {
      let devT: string | null =
        sel !== undefined && sel.kind === 'dev' && sel.dev !== undefined ? sel.dev : null
      if (devT === null && tokens.length > 0) {
        const m = [...this.devices.values()].filter((d) => this.devMatch(d, tokens[0].toLowerCase()))
        devT = m.length === 1 ? m[0].id : (m.find((d) => d.id === tokens[0].toLowerCase())?.id ?? null)
      }
      if (devT === null) {
        this.toast(tokens.length === 0 ? 'УТОЧНИ УСТРОЙСТВО — TAB ПОКАЖЕТ СПИСОК' : 'НЕТ ТАКОГО УСТРОЙСТВА')
        return
      }
      this.ensureTab(devT, true)
      this.closePalette()
      this.toast(`ТАБ: ${devT.toUpperCase()}`)
      this.schedule(() => this.render())
      return
    }
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
    const progs = PALETTE_PROGS.filter((p) => p.startsWith(pq.toLowerCase()))
    const prog = progs.find((p) => p === pq.toLowerCase()) ?? progs[0]
    if (prog === undefined) {
      // Программы нет, но устройство есть: цель выбрана — палитру закрываем
      // и переключаемся на панель деки, дальше программы доступны хоткеями
      // 1–6 (плейтест M3: «/cam1 + Enter → жми 1 2 3…»).
      if (dev !== null && tokens.length <= 1) {
        this.target = dev
        this.panes[this.activePane].tabKey = 'deck'
        this.closePalette()
        this.toast(`ЦЕЛЬ: ${dev.toUpperCase()} — ${IS_TOUCH ? 'КНОПКИ 1–6' : 'ХОТКЕИ 1–6'}`)
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
    this.camRefs = []
    this.radarRefs = []
    const main = this.main
    main.replaceChildren()

    const head = el('div', 'hv-head')
    const hostLabel =
      this.host !== '' ? ` // ${KIND_LABEL[this.hostKind ?? 'terminal']} ${this.host.toUpperCase()}` : ''
    head.append(txt('span', 'hv-title', 'HACKDECK'))
    head.append(txt('span', 'hv-host', hostLabel))
    head.append(txt('span', 'hv-net', `NET: ${this.netMbps} МБИТ`))
    if (IS_TOUCH) {
      // Джек-аут тапом: Ctrl/Cmd+ALT+DEL на телефоне недоступен (ГДД §15.2).
      const exit = el('button', 'hv-btn hv-exit-btn')
      exit.textContent = 'ВЫХОД'
      exit.addEventListener('click', () => this.deps.jackout())
      head.append(exit)
    } else {
      head.append(txt('span', 'hv-exit', 'ВЫХОД: CTRL/CMD+ALT+DEL'))
    }
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
    // Хоткей-строка — клавиатурная; на touch она бессмысленна, подсказываем
    // тап-жесты (ГДД §15.2).
    foot.textContent = IS_TOUCH
      ? 'ЧИБЫ — ТАБЫ · [ / ] ПАЛИТРА (ТАП ПО СТРОКЕ = ENTER) · ВЫХОД — КНОПКА СПРАВА'
      : 'T ТАБ [ФИЛЬТР] · W ЗАКРЫТЬ · H/V СПЛИТ · F1..F9 ПЕРЕКЛЮЧИТЬ · 1–6 ПРОГРАММЫ · / ПАЛИТРА · CTRL+ALT+DEL ДЖЕК-АУТ'
    main.append(foot)

    if (this.menuOpen) main.append(this.buildMenu())

    this.updateDeckData()
    this.updateDoorStates()
    this.updateNetmaps()
    this.updateCamFeeds()
    this.updateRadar()
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
    // Графики — одной горизонтальной строкой НАД колонками (плейтест M3:
    // в узкой левой колонке канвасы наезжали на карту сети).
    const sparks = el('div', 'hv-sparks')
    sparks.append(this.buildSpark('cpu', 'CPU'))
    sparks.append(this.buildSpark('npu', 'NPU'))
    sparks.append(this.buildSpark('ram', 'RAM'))
    sparks.append(this.buildSpark('net', 'NET'))
    const cols = el('div', 'deck-cols')
    const wrap = el('div', 'deck-wrap')
    wrap.append(sparks, cols)
    body.append(wrap)

    const left = el('div', 'deck-left')

    const progsBox = el('div', 'hv-progs')
    this.progLists.push(progsBox)
    left.append(progsBox)

    const run = el('div', 'hv-run')
    for (const [label, prog] of [
      ['1 PORTSCAN', 'portscan'],
      ['2 VULNSCAN', 'vulnscan'],
      ['3 TROJAN', 'trojan'],
      ['4 WATCHER', 'watcher'],
      ['5 FIREWALL', 'firewall'],
      ['6 ANTIVIRUS', 'antivirus'],
    ] as const) {
      const b = el('button', 'hv-btn')
      b.textContent = label + this.targetSuffix()
      b.addEventListener('click', () => this.runProg(prog))
      run.append(b)
    }
    // [ / ] — тап-эквивалент клавиши '/' (ГДД §15.2): на мобильнике хоткея нет.
    const slash = el('button', 'hv-btn hv-btn-slash')
    slash.textContent = '/ ПАЛИТРА'
    slash.addEventListener('click', () => this.openPalette('run'))
    run.append(slash)
    left.append(run)

    const right = el('div', 'deck-right')
    const netmapBox = el('div', 'hv-netmap')
    this.netmapBoxes.push(netmapBox)
    right.append(netmapBox)
    right.append(txt('div', 'netmap-hint', 'КЛИК ПО УЗЛУ — ВЫБОР ЦЕЛИ СКАНА'))

    cols.append(left, right)
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
    // Газ (M4 §14.2) — то же управляемое устройство, что дверь: общий UX-панель
    // (статус + TOGGLE + подсказка про trojan), только подпись статуса другая.
    if (d.kind === 'door' || d.kind === 'gas') {
      const wrap = el('div', 'door-ui')
      const status = el('div', 'door-status')
      wrap.append(status)
      wrap.append(txt('div', 'door-owner', `ВЛАДЕЛЕЦ: ${this.ownerLabel(d.owner)}`))
      const btn = el('button', 'hv-btn door-toggle')
      // [ПРОБЕЛ] — подсказка клавиатуры; на touch кнопка тапается (§15.2)
      btn.textContent = d.owner === this.myId && !IS_TOUCH ? 'TOGGLE [ПРОБЕЛ]' : 'TOGGLE'
      btn.disabled = d.owner !== this.myId // ctrl валидирует сервер, это только UX
      btn.addEventListener('click', () => this.deps.send({ t: 'ctrl', dev, action: 'toggle' }))
      wrap.append(btn)
      if (d.owner !== this.myId) {
        wrap.append(txt('div', 'hv-dim', 'НУЖЕН TROJAN: НА ДЕКЕ [2] VULNSCAN → [3] TROJAN'))
      }
      body.append(wrap)
      this.doorRefs.push({ dev, kind: d.kind, status, btn })
      this.appendWatchPanel(body, dev, d)
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
        wrap.append(txt('div', 'hv-dim', 'НУЖЕН TROJAN: НА ДЕКЕ [2] VULNSCAN → [3] TROJAN'))
      }
      body.append(wrap)
      this.appendWatchPanel(body, dev, d)
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
    this.appendWatchPanel(body, dev, d)
  }

  /** Панель разведки watched-устройства (§13.1 №1/№3): радар-срез (1 Гц,
   *  сервер шлёт только живому хозяину) + журнал событий. Добавляется к
   *  любому контенту таба — устройство под watcher'ом остаётся устройством
   *  (дверь так и управляется, лента камеры — идёт). */
  private appendWatchPanel(body: HTMLElement, dev: string, d: ScanDevice): void {
    if (d.watched !== true) return
    const wrap = el('div', 'watch-ui')
    wrap.append(txt('div', 'watch-owner', `ВЛАДЕЛЕЦ: ${this.ownerLabel(d.owner)} · WATCHER АКТИВЕН`))
    const radar = el('div', 'watch-radar')
    const rhead = el('div', 'watch-radar-head')
    rhead.append(txt('span', 'watch-radar-title', 'РАДАР СЕГМЕНТА'))
    const rcount = txt('span', 'watch-radar-count', 'В СЕТИ: 0')
    rhead.append(rcount)
    const rlist = el('div', 'watch-radar-list')
    radar.append(rhead, rlist)
    wrap.append(radar)
    this.radarRefs.push({ dev, list: rlist, count: rcount })
    wrap.append(this.logPanel(d))
    body.append(wrap)
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
      menu.append(txt('div', 'hv-dim', 'НЕТ ДАННЫХ — ЗАПУСТИ PORTSCAN [1]'))
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
      list.append(txt('div', 'hv-dim', IS_TOUCH ? 'ПРОЦЕССОВ НЕТ — КНОПКИ 1–6' : 'ПРОЦЕССОВ НЕТ — КЛАВИШИ 1/2/3/4/5/6'))
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
      const open = this.valveOpen.get(ref.dev) ?? false
      // газ (M4 §14.2): та же панель, другие подписи — «КЛАПАН: ОТКРЫТ/ЗАКРЫТ»
      ref.status.textContent =
        ref.kind === 'gas' ? `КЛАПАН: ${open ? 'ОТКРЫТ' : 'ЗАКРЫТ'}` : open ? 'ОТКРЫТА' : 'ЗАКРЫТА'
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

  /** Текст события журнала/радар-строки по ev (§13.1 №1/№2). */
  private evText(ev: string, prog?: string): string {
    switch (ev) {
      case 'install':
        return `УСТАНОВКА ${(prog ?? '').toUpperCase()}`
      case 'owner':
        return 'ВЛАДЕЛЕЦ'
      case 'scanhit':
        return 'УПОР-СКАН'
      default:
        return 'ДЖЕК-ИН' // старые записи без ev трактуются как jackin (§13.2)
    }
  }

  /** Имя из журнала: своё — «Я» (журнал — история устройства, свои события
   *  тоже пишутся); неизвестный (offline-хозяин) — id. */
  private logWhoName(who: number): string {
    if (who === this.myId) return 'Я'
    return this.deps.nameOf(who) ?? `#${who}`
  }

  /** Блок «ЛОГ СОБЫТИЙ» (§13.1 №1): последние сверху; данные — из
   *  scan.devices[].log, обновляются вместе с перестройкой таба на scan. */
  private logPanel(d: ScanDevice): HTMLElement {
    const box = el('div', 'watch-log')
    box.append(txt('div', 'watch-log-title', 'ЛОГ СОБЫТИЙ'))
    const list = el('div', 'watch-log-list')
    const entries: readonly LogEntry[] = d.log ?? []
    if (entries.length === 0) {
      list.append(txt('div', 'watch-empty', 'СОБЫТИЙ НЕТ'))
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      const row = el('div', 'watch-log-row')
      row.append(txt('span', 'watch-log-tick', `T${e.tick}`))
      row.append(txt('span', 'watch-log-ev', this.evText(e.ev, e.prog)))
      const name = txt('span', 'watch-log-who', this.logWhoName(e.who))
      name.style.color = this.deps.teamOf(e.who) === 1 ? '#ff4dd2' : '#37ff9b'
      row.append(name)
      list.append(row)
    }
    box.append(list)
    return box
  }

  /** Точечное обновление радар-срезов (§13.1 №3, 1 Гц): без перестройки DOM.
   *  Пустой срез — осмысленный стейт «СЕГМЕНТ ЧИСТ»; до первого среза —
   *  «ОЖИДАНИЕ СРЕЗА» (сервер шлёт 1 Гц, пауза до секунды). */
  private updateRadar(): void {
    for (const ref of this.radarRefs) {
      const who = this.radarFeeds.get(ref.dev)
      ref.count.textContent = `В СЕТИ: ${who?.length ?? 0}`
      ref.list.replaceChildren()
      if (who === undefined) {
        ref.list.append(txt('div', 'watch-empty', 'ОЖИДАНИЕ СРЕЗА…'))
        continue
      }
      if (who.length === 0) {
        ref.list.append(txt('div', 'watch-empty', 'СЕГМЕНТ ЧИСТ'))
        continue
      }
      for (const w of who) {
        const row = el('div', 'watch-radar-row')
        const name = txt('span', 'watch-radar-name', w.name)
        name.style.color = w.team === 1 ? '#ff4dd2' : '#37ff9b'
        row.append(name)
        row.append(txt('span', 'watch-radar-cls', w.cls.toUpperCase()))
        row.append(txt('span', 'watch-radar-host', `ХОСТ ${w.host.toUpperCase()}`))
        ref.list.append(row)
      }
    }
  }

  private updateNetmaps(): void {
    for (const box of this.netmapBoxes) {
      box.replaceChildren()
      box.append(this.buildNetmapSvg())
    }
  }

  /** SVG-карта сети: узлы = discovered устройства, цвет = владелец, клик = цель.
   *  Зум (плейтест M3): колесо мыши и pinch-жест — масштаб к точке курсора,
   *  двойной клик — сброс. Состояние общее для карты деки, живёт до деактивации. */
  private netmapZoom = 1
  private netmapCenter: { x: number; y: number } = {
    x: HackView.NETMAP_W / 2,
    y: HackView.NETMAP_H / 2,
  }
  private pinchDist = 0
  // Пан (плейтест M3): активные указатели + порог drag→click.
  private netmapPointers = new Set<number>()
  private netmapPanLast: { x: number; y: number } | null = null
  private netmapDragged = false
  private netmapSuppressClick = false

  private applyNetmapZoom(svg: SVGElement): void {
    const vw = HackView.NETMAP_W / this.netmapZoom
    const vh = HackView.NETMAP_H / this.netmapZoom
    // Мягкий clamp центра: видимая область не уходит за базовый прямоугольник
    // карты — пан/зум не вывозят карту в бесконечность. При zoom < 1 (обзор
    // шире базы) центр фиксируется в центре базы.
    const cx =
      vw >= HackView.NETMAP_W ? HackView.NETMAP_W / 2 : Math.min(HackView.NETMAP_W - vw / 2, Math.max(vw / 2, this.netmapCenter.x))
    const cy =
      vh >= HackView.NETMAP_H ? HackView.NETMAP_H / 2 : Math.min(HackView.NETMAP_H - vh / 2, Math.max(vh / 2, this.netmapCenter.y))
    this.netmapCenter.x = cx
    this.netmapCenter.y = cy
    svg.setAttribute('viewBox', `${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}`)
  }

  private netmapZoomAt(svg: SVGElement, clientX: number, clientY: number, factor: number): void {
    // Точка курсора в координатах viewBox должна остаться на месте.
    const rect = svg.getBoundingClientRect()
    const vb = (svg as SVGSVGElement).viewBox.baseVal
    const vx = vb.x + ((clientX - rect.left) / rect.width) * vb.width
    const vy = vb.y + ((clientY - rect.top) / rect.height) * vb.height
    const z = Math.min(5, Math.max(0.6, this.netmapZoom * factor))
    const k = this.netmapZoom / z
    this.netmapCenter.x = vx - (vx - this.netmapCenter.x) * k
    this.netmapCenter.y = vy - (vy - this.netmapCenter.y) * k
    this.netmapZoom = z
    this.applyNetmapZoom(svg)
  }

  private netmapResetZoom(svg: SVGElement): void {
    this.netmapZoom = 1
    this.netmapCenter = { x: HackView.NETMAP_W / 2, y: HackView.NETMAP_H / 2 }
    this.applyNetmapZoom(svg)
  }

  private attachNetmapZoom(svg: SVGElement): void {
    svg.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.netmapZoomAt(svg, e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }, { passive: false })
    svg.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.netmapResetZoom(svg)
    })
    // Пан зажатой ЛКМ / одним пальцем. Слушатели — на window (курсор может
    // выйти за svg посреди drag), снимаются при pointerup или когда svg уже
    // перестроен (карта перерисовывается на каждом обновлении скана).
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      this.netmapSuppressClick = false
      this.netmapPointers.add(e.pointerId)
      if (this.netmapPointers.size > 1) {
        this.netmapPanLast = null // второй палец = pinch, не пан
        return
      }
      this.netmapPanLast = { x: e.clientX, y: e.clientY }
      this.netmapDragged = false
    })
    const onMove = (e: PointerEvent): void => {
      if (!this.netmapPointers.has(e.pointerId) || this.netmapPointers.size > 1 || this.netmapPanLast === null) return
      const dx = e.clientX - this.netmapPanLast.x
      const dy = e.clientY - this.netmapPanLast.y
      // Порог 4 px: меньше — это клик по узлу (выбор цели), не drag.
      if (!this.netmapDragged) {
        if (Math.hypot(dx, dy) < 4) return
        this.netmapDragged = true
        svg.classList.add('netmap-dragging')
      }
      const rect = svg.getBoundingClientRect()
      const vb = (svg as SVGSVGElement).viewBox.baseVal
      this.netmapCenter.x -= (dx * vb.width) / rect.width
      this.netmapCenter.y -= (dy * vb.height) / rect.height
      this.netmapPanLast = { x: e.clientX, y: e.clientY }
      this.applyNetmapZoom(svg)
    }
    const onUp = (e: PointerEvent): void => {
      if (!this.netmapPointers.delete(e.pointerId)) return
      if (this.netmapDragged) {
        // Реальный drag состоялся — гасим следующий за ним click по узлу.
        this.netmapSuppressClick = true
        svg.classList.remove('netmap-dragging')
      }
      this.netmapDragged = false
      this.netmapPanLast = null
    }
    const detach = (): void => {
      window.removeEventListener('pointermove', onMoveGuarded)
      window.removeEventListener('pointerup', onUpGuarded)
      window.removeEventListener('pointercancel', onUpGuarded)
      // svg перестроен посреди жеста — сбрасываем состояние пана, чтобы
      // «залипший» suppressClick не съел следующий клик по узлу.
      this.netmapPointers.clear()
      this.netmapPanLast = null
      this.netmapDragged = false
    }
    const onMoveGuarded = (e: PointerEvent): void => {
      if (!svg.isConnected) {
        detach()
        return
      }
      onMove(e)
    }
    const onUpGuarded = (e: PointerEvent): void => {
      if (!svg.isConnected) {
        detach()
        return
      }
      onUp(e)
    }
    window.addEventListener('pointermove', onMoveGuarded)
    window.addEventListener('pointerup', onUpGuarded)
    window.addEventListener('pointercancel', onUpGuarded)
    // Pinch: масштаб по отношению расстояний между пальцами.
    svg.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        this.pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      }
    }, { passive: false })
    svg.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && this.pinchDist > 0) {
        e.preventDefault()
        const [a, b] = [e.touches[0], e.touches[1]]
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        const cx = (a.clientX + b.clientX) / 2
        const cy = (a.clientY + b.clientY) / 2
        this.netmapZoomAt(svg, cx, cy, dist / this.pinchDist)
        this.pinchDist = dist
      }
    }, { passive: false })
    svg.addEventListener('touchend', () => {
      this.pinchDist = 0
    })
    this.applyNetmapZoom(svg)
  }

  private buildNetmapSvg(): SVGElement {
    const W = HackView.NETMAP_W
    const H = HackView.NETMAP_H
    const PAD = 40
    const svg = svgEl('svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.classList.add('netmap-svg')
    this.attachNetmapZoom(svg)

    const nodes = [...this.devices.values()]
    const label = (x: number, y: number, text: string, cls: string, plate = false): void => {
      // Подложка под подпись узла: полупрозрачная тёмная плашка, чтобы
      // текст не перебивал соседние узлы/подписи (плейтест M3).
      if (plate) {
        const fs = 8
        const w = text.length * fs * 0.62 + 5
        const r = svgEl('rect')
        r.setAttribute('x', String(x - w / 2))
        r.setAttribute('y', String(y - fs))
        r.setAttribute('width', String(w))
        r.setAttribute('height', String(fs + 3))
        r.setAttribute('rx', '2')
        r.classList.add('svg-label-plate')
        svg.append(r)
      }
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
      label(W / 2, H / 2, 'ТУМАН ВОЙНЫ — PORTSCAN [1]', 'svg-dim')
      return svg
    }

    // Проекция мировые XZ→экран. Multi-floor (M4 §13.3.1, ред. плейтеста:
    // ярусы НЕ должны пересекаться — никакой ISO-накидки поверх плана):
    // каждый ярус получает свою горизонтальную полосу и свой fit по своему
    // bbox — полосы не пересекаются по построению, а стояк c9 (s2→s3) —
    // единственный мост между ними (голубой пунктир). Ярусы: y<4 → Э1,
    // y<11 → Э2 (пороги от реальных плит m1: терраса y=8). Одноэтажная
    // сеть = одна полоса на всю высоту ≈ прежняя проекция.
    const levelOf = (y: number): number => (y < 4 ? 0 : y < 11 ? 1 : 2)
    const levels = [...new Set(nodes.map((d) => levelOf(d.y)))].sort((a, b) => a - b)
    const shelfIdx = new Map<number, number>() // levelOf → индекс снизу (0=низ)
    levels.forEach((lv, i) => shelfIdx.set(lv, i))
    const BAND_GAP = 16
    const bandH = (H - 20 - 28 - BAND_GAP * (levels.length - 1)) / levels.length
    const fits = new Map<number, { k: number; ox: number; oz: number; bandTop: number }>()
    for (const lv of levels) {
      const s = shelfIdx.get(lv) ?? 0
      const bandBottom = H - 20 - s * (bandH + BAND_GAP)
      const bandTop = bandBottom - bandH
      const innerTop = bandTop + 18 // строка «ЭN» сверху полосы
      const innerBottom = bandBottom - 6
      let lx0 = Number.POSITIVE_INFINITY
      let lx1 = Number.NEGATIVE_INFINITY
      let lz0 = Number.POSITIVE_INFINITY
      let lz1 = Number.NEGATIVE_INFINITY
      for (const d of nodes) {
        if (levelOf(d.y) !== lv) continue
        lx0 = Math.min(lx0, d.x)
        lx1 = Math.max(lx1, d.x)
        lz0 = Math.min(lz0, d.z)
        lz1 = Math.max(lz1, d.z)
      }
      const sx = Math.max(lx1 - lx0, 1)
      const sz = Math.max(lz1 - lz0, 1)
      const k = Math.min((W - PAD * 2 - 30) / sx, (innerBottom - innerTop) / sz)
      fits.set(lv, {
        k,
        ox: PAD + 14 + (W - PAD * 2 - 30 - sx * k) / 2 - lx0 * k,
        oz: innerTop + (innerBottom - innerTop - sz * k) / 2 - lz0 * k,
        bandTop,
      })
    }
    const screenFor = (d: ScanDevice): { x: number; y: number } => {
      const f = fits.get(levelOf(d.y))
      if (f === undefined) return { x: W / 2, y: H / 2 }
      return { x: f.ox + d.x * f.k, y: f.oz + d.z * f.k }
    }

    // Declutter: мировые координаты дают наложения (в m1 cam1/d1 и cam2/d2
    // проектируются в ~16 px друг от друга). Раздвижение пар ближе MIN_DIST
    // до сходимости + кламп ВНУТРИ СВОЕЙ ПОЛОСЫ яруса (плейтест M4: узлы не
    // должны пересекать границы этажей).
    const pos = new Map<string, { x: number; y: number }>()
    for (const d of nodes) pos.set(d.id, screenFor(d))
    const MIN_DIST = 30
    for (let pass = 0; pass < 16; pass++) {
      let maxPush = 0
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = pos.get(nodes[i].id)
          const b = pos.get(nodes[j].id)
          if (a === undefined || b === undefined) continue
          let dx = b.x - a.x
          let dy = b.y - a.y
          const d = Math.hypot(dx, dy)
          if (d >= MIN_DIST) continue
          if (d < 0.01) {
            dx = 0
            dy = 1 // полный сдвиг: два узла в одной точке
          } else {
            dx /= d
            dy /= d
          }
          const push = (MIN_DIST - d) / 2 + 0.5
          maxPush = Math.max(maxPush, push)
          a.x -= dx * push
          a.y -= dy * push
          b.x += dx * push
          b.y += dy * push
        }
      }
      if (maxPush < 0.5) break
    }
    // Кламп строго внутри своей полосы: узел никогда не покидает этаж.
    for (const d of nodes) {
      const p = pos.get(d.id)
      const f = fits.get(levelOf(d.y))
      if (p === undefined || f === undefined) continue
      p.x = Math.max(14, Math.min(W - 14, p.x))
      p.y = Math.max(f.bandTop + 10, Math.min(f.bandTop + bandH - 6, p.y))
    }

    // Полосы этажей: подложка на всю ширину + подпись. Рисуем до связей —
    // фон. Стояк c9 виден поверх полос и читается как «вертикаль сквозь
    // перекрытия».
    for (const lv of levels) {
      const f = fits.get(lv)
      if (f === undefined) continue
      const r = svgEl('rect')
      r.setAttribute('x', '8')
      r.setAttribute('y', String(f.bandTop))
      r.setAttribute('width', String(W - 16))
      r.setAttribute('height', String(bandH))
      r.setAttribute('rx', '8')
      r.setAttribute('fill', 'rgba(55,255,155,0.03)')
      r.setAttribute('stroke', 'rgba(55,255,155,0.28)')
      r.setAttribute('stroke-dasharray', '3 5')
      svg.append(r)
      const t = svgEl('text')
      t.setAttribute('x', '18')
      t.setAttribute('y', String(f.bandTop + 12))
      t.setAttribute('fill', '#4fae8b')
      t.setAttribute('font-size', '9')
      t.textContent = `Э${lv + 1}`
      svg.append(t)
    }

    // связи (дедуп по паре); координаты — после declutter. Связь между
    // полками (стояк c9 s2→s3) — отдельный голубой пунктир: читается как
    // «сквозь перекрытие», а не как соседство на плане (§13.3.1).
    const seen = new Set<string>()
    const drawLink = (a: ScanDevice, b: ScanDevice): void => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      if (seen.has(key)) return
      seen.add(key)
      const pa = pos.get(a.id)
      const pb = pos.get(b.id)
      if (pa === undefined || pb === undefined) return
      if (levelOf(a.y) !== levelOf(b.y)) {
        const l = svgEl('line')
        l.setAttribute('x1', String(pa.x))
        l.setAttribute('y1', String(pa.y))
        l.setAttribute('x2', String(pb.x))
        l.setAttribute('y2', String(pb.y))
        l.setAttribute('class', 'svg-link svg-riser')
        svg.append(l)
        return
      }
      const wireless = a.kind === 'radio' || b.kind === 'radio'
      line(pa.x, pa.y, pb.x, pb.y, wireless ? 'svg-link svg-wireless' : 'svg-link')
    }
    for (const d of nodes) {
      for (const l of d.links) {
        const o = this.devices.get(l)
        if (o !== undefined) drawLink(d, o)
      }
    }

    // Дека — узел РЯДОМ с точкой джек-ина (плейтест M4: в углу она «вне
    // этажей», а смысл — «откуда сижу»): ставим на 40 px от хоста по
    // направлению к центру его полосы, клампим в полосу; подпись — ДЕКА·ID.
    const hostDev = this.devices.get(this.host)
    const hostPos = hostDev !== undefined ? pos.get(hostDev.id) : undefined
    if (hostPos !== undefined && hostDev !== undefined) {
      const hf = fits.get(levelOf(hostDev.y))
      const bandTop = hf?.bandTop ?? 10
      let dirY = (bandTop + bandH / 2 - hostPos.y >= 0 ? 1 : -1)
      const deckX = Math.max(20, Math.min(W - 20, hostPos.x - 40))
      const deckY = Math.max(
        bandTop + 10,
        Math.min(bandTop + bandH - 6, hostPos.y + dirY * (Math.abs(hostPos.x - deckX) < 12 ? 36 : 18)),
      )
      line(deckX, deckY, hostPos.x, hostPos.y, 'svg-link svg-link-deck')
      const deck = svgEl('circle')
      deck.setAttribute('cx', String(deckX))
      deck.setAttribute('cy', String(deckY))
      deck.setAttribute('r', '6')
      deck.classList.add('svg-deck')
      svg.append(deck)
      label(deckX, deckY + 18, `ДЕКА·${hostDev.id.toUpperCase()}`, 'svg-label', true)
    }

    // устройства
    for (const d of nodes) {
      const p = pos.get(d.id)
      if (p === undefined) continue
      const cx = p.x
      const cy = p.y
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
        // Короткий бейдж: цвет уже кодирует свой/чужой, полный текст — в
        // tooltip узла (плейтест M3: длинные бейджи наезжали на подписи).
        badge.textContent = 'FW'
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
        // После реального drag (≥4 px) клик по узлу гасится — это был пан.
        if (this.netmapSuppressClick) {
          this.netmapSuppressClick = false
          return
        }
        this.target = d.id
        this.schedule(() => this.render())
      })
      svg.append(c)
      const title = svgEl('title')
      let tip = `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`
      if (d.firewalled === true) tip += ` · FIREWALL: ${this.fwLabel(d.firewalledBy ?? 0)}`
      title.textContent = tip
      c.append(title)
      label(cx, cy + 19, d.id.toUpperCase(), 'svg-label', true)
    }
    return svg
  }
}
