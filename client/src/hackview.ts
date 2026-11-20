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
  DataItem,
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
  enemy_team: 'УСТРОЙСТВО ЗАХВАЧЕНО ДРУГОЙ КОМАНДОЙ',
  not_jacked: 'НЕ В СЕТИ',
  no_los: 'НЕТ ПРЯМОЙ ВИДИМОСТИ',
  too_far: 'СЛИШКОМ ДАЛЕКО',
  bad_target: 'НЕВЕРНАЯ ЦЕЛЬ',
  antivirus: 'ANTIVIRUS — УСТАНОВКА TROJAN ОТБИТА',
  // §13.5 (плейтест M4): скан упёрся в чужой фильтр — скан не отменён,
  // но за хостом из dev ничего нового не открыто.
  firewall_scan: 'СКАН УПОРСЯ В FIREWALL',
  // §16.4: decrypt требует нейромодуля — терминалы/свитчи/двери не умеют.
  npu: 'НУЖЕН NPU — DECRYPT ТОЛЬКО НА ДЕКЕ ИЛИ SRV',
  // плейтест «не смешивать»: dup = уже скопировано (cp/mv), decrypted =
  // уже расшифровано (decrypt), in_progress = расшифровка уже летит
  dup: 'УЖЕ СКОПИРОВАНО',
  decrypted: 'УЖЕ РАСШИФРОВАНО',
  in_progress: 'УЖЕ РАСШИФРОВЫВАЕТСЯ',
}

// Только сетевые устройства: fire (M4 §14.6.1) — не девайс, в деку не попадает
// (его контроллер — клапан), поэтому в словаре подписи fire нет (тип CyberKind
// это и сторожит).
const KIND_LABEL: Readonly<Record<CyberKind, string>> = {
  terminal: 'ТЕРМИНАЛ',
  radio: 'РАДИО-ТОЧКА',
  switch: 'SWITCH',
  door: 'ДВЕРЬ',
  camera: 'КАМЕРА',
  cable: 'КАБЕЛЬ',
  gas: 'ГАЗ',
  valve: 'КЛАПАН',
  srv: 'СЕРВЕР',
  keypad: 'КЛАВИАТУРА',
  safe: 'NETSAFE',
}

const PROG_LABEL: Readonly<Record<string, string>> = {
  portscan: 'PORTSCAN',
  vulnscan: 'VULNSCAN',
  trojan: 'TROJAN',
  watcher: 'WATCHER',
  firewall: 'FIREWALL',
  antivirus: 'ANTIVIRUS',
  cp: 'CP',
  mv: 'MV',
  rm: 'RM',
  decrypt: 'DECRYPT',
}

/** Скан-программы — у них живая карточка с % (deck.pct), не тост-«ЗАПУЩЕНО». */
const SCAN_PROGS: ReadonlySet<string> = new Set(['portscan', 'vulnscan', 'trojan', 'watcher', 'firewall', 'antivirus'])

/** Программы слэш-палитры (ГДД §13.3) — порядок = порядок ряда хоткеев 1..6. */
const PALETTE_PROGS: readonly RunProg[] = [
  'portscan',
  'vulnscan',
  'trojan',
  'watcher',
  'firewall',
  'antivirus',
]

/** Шелл-команда данных (§16.2): `data [host] ls|cp|rm …` — клиентский
 *  парсер поверх wire-программ cp/rm; ls рендерится в палитре. */
const DATA_CMD = 'data'
type DataSub = 'ls' | 'cp' | 'mv' | 'rm' | 'decrypt'
const DATA_SUBS: readonly DataSub[] = ['ls', 'cp', 'mv', 'rm', 'decrypt']

/** Короткие алиасы kind для фильтра палитры: /term, /cam (ГДД §13.3). */
const KIND_ALIAS: Readonly<Record<string, PropKind>> = {
  term: 'terminal',
  radio: 'radio',
  switch: 'switch',
  door: 'door',
  cam: 'camera',
  gas: 'gas', // M4 §14.2: фильтр палитры по kind и по-русски
  газ: 'gas',
  valve: 'valve', // M4 §14.6.1: водяной клапан
  клапан: 'valve',
}

/** Кандидат слэш-палитры: устройство, программа, item данных (§16.2),
 *  подкоманда data, сама команда data или decrypt (§16.4). */
interface PalCand {
  kind: 'dev' | 'prog' | 'item' | 'sub' | 'datacmd' | 'decryptcmd'
  /** Что вставляется в токен при автодополнении. */
  text: string
  dev?: string
  prog?: RunProg
  data?: string // item: имя данных
  label: string
  hint: string
  /** §15.28: владение для цветовой подсветки hint'а (зелёный/жёлтый/красный);
   *  undefined — hint показывает не владельца (программа, MEM, «в табах»). */
  owner?: number | null
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

/** Раскладка не EN-US → латинская буква по физкоду (плейтест M5, desktop).
 *  Строки палитры — латинские токены (id/программы), а клавиатурный ввод из
 *  русской раскладки даёт кириллицу («саш1» вместо «cam1»), которая не матчит
 *  ничего — тестирование превращалось в жонглирование раскладками. e.code
 *  надёжен во всех раскладках (тот же принцип, что у '/' — §13.3), поэтому
 *  для Key[A-Z] берём букву из кода. Возвращает символ для вставки или null
 *  (null = раскладка уже латинская / не буква → дефолтный ввод браузера). */
function latinForKey(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null
  if (!/^Key[A-Z]$/.test(e.code)) return null
  if (/^[a-zA-Z]$/.test(e.key)) return null // EN-US и другие латинские раскладки не трогаем
  return e.shiftKey ? e.code.slice(3) : e.code.slice(3).toLowerCase()
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
  /** §15.29: ландшафт тача — широкая низкая карта (band'ы этажей рядом по
   *  горизонтали вместо двух горизонтальных полос, сжимающих узлы в кашу). */
  private static readonly NETMAP_W_LAND = 780
  private static readonly NETMAP_H_LAND = 180
  /** Карта на тапе (§15.7): базовый зум > 1 — на 390px-высоте телефона
   *  фиксированная геометрия viewBox (узлы r=7, подписи 8px) давала ~5 css
   *  px; отталкиваемся от 1.5×, pinch по-прежнему разматывает до 0.6 (вся
   *  карта) и зумит до 5. Десктоп: 1, побайтно прежнее. */
  private static readonly NETMAP_ZOOM0 = IS_TOUCH ? 1.5 : 1
  /** Масштаб геометрии узлов на карте (r, подписи, ореолы) — тоже только
   *  для тача: крупные цели тапа + разборчивые подписи. */
  private static readonly NETMAP_S = IS_TOUCH ? 1.45 : 1

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
  private deckData: readonly DataItem[] = [] // §16.1: инвентарь MEM деки
  /** Анимированные cp-тосты (§16.2, плейтест «давай анимацию»): живая полоса
   *  трансфера из deck-сообщения 2 Гц; missed — тики без процесса (финиш). */
  private cpToasts: {
    key: string
    prog: 'cp' | 'mv'
    dev: string
    dst: string
    data: string
    mb: number
    wrap: HTMLElement
    fill: HTMLElement
    status: HTMLElement
    missed: number
    seen: boolean // карточка видела реальный прогресс (иначе — отказ на старте)
  }[] = []
  /** Карточки сканов (плейтест M5: «бабл ушёл, а portscan идёт»): живой %
   *  любой скан-программы из deck-сообщения 2 Гц (поле pct), финиш — как у
   *  cp: «ГОТОВО ✓», не видевшая прогресса карточка — отказ на старте. */
  private scanCards: {
    prog: string
    dev: string // "" у portscan без цели
    wrap: HTMLElement
    fill: HTMLElement
    status: HTMLElement
    missed: number
    seen: boolean // карточка видела реальный прогресс (иначе — отказ на старте)
  }[] = []
  /** DECRYPT-карточки (§16.4, плейтест «другую анимацию, со %»): голубой
   *  NPU-бар, крупный процент, бегущая hex-строка. Прогресс из двух каналов:
   *  job 1 Гц (SRV-джобы, всей команде) и deck-сообщение 2 Гц (джоба деки);
   *  CSS transition сглаживает низкую частоту. timer — hex-скрэмбл-интервал. */
  private jobCards: {
    key: string
    dev: string
    data: string
    wrap: HTMLElement
    fill: HTMLElement
    pct: HTMLElement
    scr: HTMLElement
    seen: boolean // карточка видела реальный прогресс (иначе — отказ на старте)
    missed: number // дековые: тики deck-сообщения без процесса (финиш)
    timer: number
  }[] = []
  private deckMemUsed = 0
  private deckMemCap = 0
  private deckDataBox: HTMLElement | null = null // живой список в табе ДЕКА
  private deckMemLine: HTMLElement | null = null
  private readonly hist = {
    cpu: [] as number[],
    npu: [] as number[],
    ram: [] as number[],
    net: [] as number[],
  }
  /** Обнаруженные устройства живут между джек-инами (туман войны — свои знания). */
  private devices = new Map<string, ScanDevice>()
  /** open-состояния дверей, газовых и водяных клапанов из снапа (общий механизм). */
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
  /** Палитра-дерево на тапе (§15.7): выбранный второй уровень (устройство)
   *  или null — ряд устройств. */
  private paletteDev: string | null = null
  /** §16.2 ls-листинг в палитре («терминал»): host ('deck'|devId), чьи
   *  данные показаны в списке кандидатов; null — обычные кандидаты.
   *  Сбрасывается ручным вводом (input-событие) и закрытием палитры. */
  private paletteLs: string | null = null
  /** §15.25: активный префикс-чип touch-палитры (CAM/SRV/S/…), null — сетка
   *  чипов. Только когда групп много: плоский список из 25+ устройств на
   *  телефоне — «пипец здоровый, искать неудобно скролом» (ревебр owner). */
  private paletteGroup: string | null = null
  /** Touch-дерево §16.2: уровень items хоста ('deck'|devId) / уровень
   *  приёмника cp (выбранный item). null — обычные уровни дерева. */
  private paletteDataHost: string | null = null
  private paletteDataItem: { host: string; key: string; prog: 'cp' | 'mv' } | null = null

  // Слэш-палитра (§13.3): командная строка запуска программ с клавиатуры.
  // input === null на тапе: дерево кнопок без поля ввода и без системной
  // клавиатуры — она съедала до 90% экрана (ревебр owner, §15.7).
  private palette: { wrap: HTMLElement; input: HTMLInputElement | null; list: HTMLElement } | null = null
  private paletteCands: readonly PalCand[] = []
  private paletteSel = -1
  /** Токен, который дополняет Tab: 0 = устройство, 1 = программа, у data
   *  (§16.2) — дальше по грамматике (хост → подкоманда → ключ → приёмник). */
  private paletteTok = 0
  private readonly cmdHistory: string[] = []
  private histIdx = 0

  // Refs для точечных обновлений без перестройки DOM (клики не срываются).
  private sparkRefs: SparkRef[] = []
  private progLists: HTMLElement[] = []
  private netmapBoxes: HTMLElement[] = []
  /** Табы управляемых устройств (двери + газ/вода клапаны): точечное обновление
   *  статуса/кнопки без перестройки DOM. kind нужен для подписи статуса. */
  private doorRefs: { dev: string; kind: 'door' | 'gas' | 'valve'; status: HTMLElement; btn: HTMLButtonElement }[] = []
  private camRefs: { dev: string; list: HTMLElement; time: HTMLElement; count: HTMLElement }[] = []
  private radarRefs: { dev: string; list: HTMLElement; count: HTMLElement }[] = []

  constructor(private deps: HackViewDeps) {
    this.root = byId('hackview')
    this.root.classList.add('hidden')
    this.main = el('div', 'hv-main')
    this.toasts = el('div', 'hv-toasts')
    this.root.append(this.main, this.toasts)
    window.addEventListener('keydown', this.onKeyDown)
    // §15.29: раскрой карты привязан к ориентации (landscape — широкие
    // колонки-полосы) — при повороте экрана карта перестраивается сама,
    // без ожидания следующего скана.
    if (IS_TOUCH) {
      const mq = matchMedia('(orientation: landscape) and (min-width: 600px)')
      mq.addEventListener('change', () => {
        if (this._active) this.schedule(() => this.updateNetmaps())
      })
    }
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
    // cp-тосты прошлой сессии деки мертвы вместе с ней (transfers отменены
    // сервером при джек-ауте) — не оставляем висеть
    this.cpToasts = []
    // DECRYPT-карточки тоже: дековые джобы отменены джек-аутом, SRV живёт,
    // но её карточка пересоздастся из job при новом джек-ине. Интервалы —
    // остановить (утечка setInterval, §16.4). Контейнер — под ноль:
    // никаких зомби-карточек прошлой сессии.
    for (const r of this.jobCards) window.clearInterval(r.timer)
    this.jobCards = []
    this.cpToasts = []
    this.scanCards = []
    this.toasts.replaceChildren()
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
    this.netmapZoom = HackView.NETMAP_ZOOM0 // зум/пан карты не переживает сессию деки
    this.netmapCenter = { x: HackView.NETMAP_W / 2, y: HackView.NETMAP_H / 2 }
    this.netmapLand = false // §15.29: следующая сессия пересинхронизирует раскрой
    // §15.26: jack-out посреди жеста — залипшие указатели/холд въелись бы в
    // следующий render() деки (гейт §15.26 увидел бы «жест идёт» вечно).
    this.netmapPointers.clear()
    this.pinchDist = 0
    this.netmapPanLast = null
    this.netmapDragged = false
    this.netmapRenderHeld = false
    this.pendingJobs = []
    if (this.raf !== null) {
      window.cancelAnimationFrame(this.raf)
      this.raf = null
    }
    this.root.classList.add('hidden')
    this.main.replaceChildren()
    // Тосты деки умирают с декой (плейтест: после смерти на экране навсегда
    // висела DECRYPT-карточка «51%» — массивы чистились, DOM нет). Интервалы
    // hex-скрэмбла DECRYPT-карточек — тоже.
    for (const r of this.jobCards) window.clearInterval(r.timer)
    this.jobCards = []
    this.cpToasts = []
    this.scanCards = []
    this.toasts.replaceChildren()
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
    this.deckData = msg.data ?? []
    this.deckMemUsed = msg.memUsed ?? this.deckMemUsed
    this.deckMemCap = msg.mem ?? this.deckMemCap
    this.updateCpToasts()
    this.schedule(() => this.updateDeckData())
    // подсветка каналов активных операций (path в progs) — 2 Гц с deck-тиком.
    // §15.26: только hi-слой, без rebuild каркаса — карта не вырывает палец
    // посреди пана/пинча.
    this.schedule(() => this.refreshNetmapHi())
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
    // Открытая палитра-дерево (touch) — список устройств устарел со сканом.
    if (this.palette !== null && this.palette.input === null) {
      if (this.paletteDev !== null && !next.has(this.paletteDev)) this.paletteDev = null
      // §15.25: группа пропала со сканом (устройства рас-сканированы) — на чипы
      if (this.paletteGroup !== null && ![...next.keys()].some((id) => this.devGroup(id) === this.paletteGroup))
        this.paletteGroup = null
      this.updatePalette()
    }
    this.schedule(() => this.render())
  }

  onDenied(msg: DeniedMsg): void {
    if (!this._active) return
    // cp_cancel (§16.2): у активного cp/mv-тоста своя судьба — полоса
    // краснеет и мигает («ой-ой отказ»), общий тост не нужен (дубль).
    if (msg.reason === 'cp_cancel') {
      this.failCpToasts(msg.dev ?? '')
      return
    }
    // Отказ decrypt (§16.4): красим ТУ ЖЕ DECRYPT-карточку (плейтест «два
    // прогрессбара» — вторую не плодим); нет карточки — готовая красная.
    if (msg.prog === 'decrypt') {
      const r = this.jobCards.find((x) => x.data === msg.data)
      if (r !== undefined) {
        this.jobCardFinish(r, false)
      } else {
        this.denyCard('decrypt', msg.data ?? '', msg.reason)
      }
      return
    }
    // Отказ data-операции (denied несёт prog/data, §16.2): красим ТУ ЖЕ
    // оптимистичную карточку красным мигающим баром (плейтест: «два
    // прогрессбара» — вторую не плодим); карточки нет (rm или рассинхрон) —
    // создаём готовую красную.
    if (msg.prog === 'cp' || msg.prog === 'mv' || msg.prog === 'rm') {
      const base = DENIED_TEXT[msg.reason] ?? `ОТКАЗАНО: ${msg.reason}`
      const r =
        msg.prog === 'rm'
          ? undefined
          : this.cpToasts.find((x) => x.prog === msg.prog && x.data === msg.data)
      if (r !== undefined) {
        this.cpToasts = this.cpToasts.filter((x) => x !== r)
        this.failCard(r, base)
      } else {
        this.denyCard(msg.prog, msg.data ?? '', msg.reason)
      }
      return
    }
    const base = DENIED_TEXT[msg.reason] ?? `ОТКАЗАНО: ${msg.reason}`
    // firewall_scan несёт хост с фильтром (§13.5) — показываем, ГДЕ упёрся
    // и что с этим делать (плейтест M4: тост без действия бесполезен).
    this.toast(msg.dev !== undefined ? `${base} (${msg.dev.toUpperCase()}) — НУЖЕН TROJAN НА ХОСТЕ` : base)
  }

  /** Карточка отказа data-операции: бар полный красный, мигает (§16.2). */
  private denyCard(prog: 'cp' | 'mv' | 'rm' | 'decrypt', key: string, reason: string): void {
    const wrap = el('div', 'hv-toast hv-cptoast fail')
    const row = el('div', 'cprow')
    row.append(
      txt('span', 'cptitle', `${prog.toUpperCase()} ${key.toUpperCase()} ✗`),
      txt('span', 'cpdst', 'ОТКАЗ'),
    )
    const bar = el('div', 'cpbar')
    const fill = el('div', 'cpbar-fill')
    fill.style.width = '100%'
    bar.append(fill)
    const base = DENIED_TEXT[reason] ?? `ОТКАЗАНО: ${reason}`
    const status = txt('div', 'cpstatus', base)
    wrap.append(row, bar, status)
    this.toasts.append(wrap)
    this.fadeCard(wrap, 2600)
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
      // газ (M4 §14.2) и водяной клапан (§14.6.1) — то же поле open,
      // тот же механизм таб-панели, что у двери
      if ((p.kind !== 'door' && p.kind !== 'gas' && p.kind !== 'valve') || p.open === undefined) continue
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
      // ПРОБЕЛ = TOGGLE на табе двери-владения — ВЕЗДЕ, даже когда фокус на
      // кнопке (фикс плейтеста: после Enter на линке фокус оставался на чипе
      // S1, и пробел «не работал» до клика мышью). preventDefault гасит
      // нативную активацию сфокусированной кнопки — двойного тоггла нет.
      const pane0 = this.panes[this.activePane]
      const tab0 = this.tabs.find((t) => t.key === pane0?.tabKey)
      const dev0 = tab0?.dev !== null && tab0?.dev !== undefined ? this.devices.get(tab0.dev) : undefined
      if (dev0 !== undefined && (dev0.kind === 'door' || dev0.kind === 'gas' || dev0.kind === 'valve')) {
        e.preventDefault()
        if (dev0.owner === this.myId) {
          this.deps.send({ t: 'ctrl', dev: dev0.id, action: 'toggle' })
        } else {
          // Не-владелец: молчаливый пробел выглядел как «клавиша мертва»
          // (плейтест M4) — явно говорим, почему и что делать.
          this.toast(`${dev0.id.toUpperCase()}: НЕ ВЛАДЕЛЕЦ — НУЖЕН TROJAN`)
        }
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
    // Хоткеи программ — из ЛЮБОГО таба (плейтест M4: S/V/D/G/T/R/CAM тоже,
    // не только дека; ГДД §12.6). Цель — устройство АКТИВНОГО таба: «смотрю
    // на D1 — цифры работают на D1», а не на последнюю цель с карты (фикс
    // плейтеста: софт уходил на S1, с которого открыли таб). На деке цель —
    // выбранная на карте сети, как раньше.
    const pane = this.panes[this.activePane]
    const tabDev = pane !== undefined ? (this.tabs.find((t) => t.key === pane.tabKey)?.dev ?? null) : null
    if (e.code === 'Digit1') {
      e.preventDefault()
      this.runProgAt('portscan', tabDev)
    } else if (e.code === 'Digit2') {
      e.preventDefault()
      this.runProgAt('vulnscan', tabDev)
    } else if (e.code === 'Digit3') {
      e.preventDefault()
      this.runProgAt('trojan', tabDev)
    } else if (e.code === 'Digit4') {
      e.preventDefault()
      this.runProgAt('watcher', tabDev)
    } else if (e.code === 'Digit5') {
      e.preventDefault()
      this.runProgAt('firewall', tabDev)
    } else if (e.code === 'Digit6') {
      e.preventDefault()
      this.runProgAt('antivirus', tabDev)
    } else if (e.code === 'Digit7') {
      e.preventDefault()
      this.dataEntry()
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
    this.deps.send(
      needDev && target !== null ? { t: 'run', prog, dev: target } : { t: 'run', prog },
    )
    // Сканы живут своей карточкой с % (плейтест: «бабл ушёл, а portscan
    // идёт») — тост-«ЗАПУЩЕНО» у них только дубль.
    if (SCAN_PROGS.has(prog)) {
      this.scanCardStart(prog, needDev && target !== null ? target : '')
      return
    }
    const devSuffix = needDev && target !== null ? ` → ${target.toUpperCase()}` : ''
    this.toast(`ЗАПУЩЕНО: ${PROG_LABEL[prog] ?? prog}${devSuffix}`)
  }

  /** Карточка скана: полоса с % (deck 2 Гц, поле pct) и ETA — portscan
   *  без цели это «ПОИСК СЕТИ», у целевых сканов цель в заголовке. */
  private scanCardStart(prog: string, dev: string): void {
    const wrap = el('div', 'hv-toast hv-cptoast scan')
    const row = el('div', 'cprow')
    row.append(
      txt('span', 'cptitle', `${PROG_LABEL[prog as RunProg] ?? prog.toUpperCase()}${dev === '' ? '' : ` · ${dev.toUpperCase()}`}`),
      txt('span', 'cpdst', dev === '' ? 'ПОИСК СЕТИ' : prog === 'vulnscan' || prog === 'portscan' ? 'СКАНИРОВАНИЕ' : 'УСТАНОВКА'),
    )
    const bar = el('div', 'cpbar')
    const fill = el('div', 'cpbar-fill')
    fill.style.width = '0%'
    bar.append(fill)
    const status = txt('div', 'cpstatus', '0%')
    wrap.append(row, bar, status)
    this.toasts.append(wrap)
    this.scanCards.push({ prog, dev, wrap, fill, status, missed: 0, seen: false })
    this.capToasts() // §15.30
  }

  /** 2 Гц: прогресс скан-карточек из deck-сообщения; два тика без процесса —
   *  финиш (как у cp-тостов: видевшая прогресс — «ГОТОВО ✓», не видевшая —
   *  отказ сервера на старте). */
  private updateScanCards(): void {
    for (const r of [...this.scanCards]) {
      const p = this.progs.find((q) => q.prog === r.prog && (q.dev ?? '') === r.dev)
      if (p !== undefined) {
        r.seen = true
        r.missed = 0
        r.fill.style.width = `${Math.round(p.pct * 100)}%`
        const eta = Math.ceil(p.etaMs / 1000)
        r.status.textContent = `${Math.round(p.pct * 100)}% · ${eta} С`
        continue
      }
      r.missed += 1
      if (r.missed < 2) continue
      this.scanCards = this.scanCards.filter((x) => x !== r)
      if (r.seen) {
        r.wrap.classList.add('ok')
        r.fill.style.width = '100%'
        r.status.textContent = 'ГОТОВО ✓'
        this.fadeCard(r.wrap, 1300)
      } else {
        r.wrap.classList.add('fail')
        r.fill.style.width = '100%'
        r.status.textContent = 'ОТКАЗ НА СТАРТЕ'
        this.fadeCard(r.wrap, 2200)
      }
    }
  }

  // ── команда данных `data` (§16.2) ───────────────────────────────────────

  /** Контекст данных (§16.2, плейтест: «жму data ls — а оно на деке, хотя
   *  T1 затроянен»): устройство активного таба → выбранная на карте цель →
   *  дека. Как у остального софта: цель — то, на что жал. */
  private dataCtxHost(): string {
    const pane = this.panes[this.activePane]
    const dev = pane !== undefined ? (this.tabs.find((t) => t.key === pane.tabKey)?.dev ?? null) : null
    if (dev !== null) return dev
    if (this.target !== null) return this.target
    return 'deck'
  }

  /** Токен — адресуемый хост data: 'deck' (алиас localhost, §16.2) или
   *  устройство (префикс, уникальный). */
  private dataHostAt(q: string): string | null {
    if (q === 'deck' || q === 'localhost') return 'deck'
    if (q === '') return null
    const m = [...this.devices.values()].filter((d) => this.devMatch(d, q))
    return m.length === 1 ? m[0].id : (m.find((d) => d.id === q)?.id ?? null)
  }

  /** Видимые items хоста: дека всегда, устройство — только своё (data
   *  шлётся сервером лишь владельцу, §16.9). */
  private dataHostItems(host: string): readonly DataItem[] {
    if (host === 'deck') return this.deckData
    const d = this.devices.get(host)
    return d !== undefined && d.owner === this.myId ? (d.data ?? []) : []
  }

  private dataHostLabel(host: string): string {
    if (host === 'deck') return 'ДЕКА'
    const d = this.devices.get(host)
    return `${host.toUpperCase()} ${d !== undefined ? KIND_LABEL[d.kind] : ''}`.trim()
  }

  private dataHostMem(host: string): string {
    if (host === 'deck') return this.deckMemUsed > 0 || this.deckMemCap > 0 ? `${this.deckMemUsed}/${this.deckMemCap} МБ` : ''
    const d = this.devices.get(host)
    return d !== undefined && d.mem !== undefined ? `${d.mem - (d.memFree ?? 0)}/${d.mem} МБ` : ''
  }

  /** Все свои источники данных (для резолвции ключа без префикса): дека +
   *  захваченные хосты с items. */
  private dataSources(): { host: string; items: readonly DataItem[] }[] {
    const out: { host: string; items: readonly DataItem[] }[] = []
    for (const d of this.devices.values()) {
      if (d.owner === null || d.owner !== this.myId || d.data === undefined || d.data.length === 0) continue
      out.push({ host: d.id, items: d.data })
    }
    if (this.deckData.length > 0) out.push({ host: 'deck', items: this.deckData })
    return out
  }

  /** Кнопка 7 DATA / хоткей 7 (§16.2): desktop — палитра сразу с листингом
   *  активного таба, touch — дерево на уровне ДАННЫЕ (или корень). */
  private dataEntry(): void {
    this.openPalette('run')
    if (IS_TOUCH) {
      const host = this.dataCtxHost()
      if (this.dataHostItems(host).length > 0) this.paletteDataHost = host
      this.updatePalette()
      return
    }
    const pal = this.palette
    if (pal !== null && pal.input !== null) {
      const host = this.dataCtxHost()
      pal.input.value = host === 'deck' ? 'data ls' : `data ${host} ls`
      this.execDataLs(host, pal.input.value)
    }
  }

  /** Резолвция источника: явный хост → активный таб → дека → единственный
   *  свой хост; неоднозначно — null + тост-подсказка (§16.2). */
  private resolveDataSrc(name: string, host: string | null): { host: string; key: string } | null {
    const find = (items: readonly DataItem[]): DataItem | undefined => items.find((it) => it.n === name)
    if (host !== null) {
      const it = find(this.dataHostItems(host))
      if (it === undefined) {
        this.toast(`НЕТ «${name.toUpperCase()}» НА ${host === 'deck' ? 'ДЕКЕ' : host.toUpperCase()}`)
        return null
      }
      return { host, key: it.n }
    }
    const active = this.dataCtxHost()
    const srcs = this.dataSources()
    const hits = srcs.filter((s) => find(s.items) !== undefined)
    const pick = hits.find((s) => s.host === active) ?? hits.find((s) => s.host === 'deck')
    if (pick !== undefined) return { host: pick.host, key: name }
    if (hits.length === 1) return { host: hits[0].host, key: name }
    if (hits.length > 1) {
      this.toast(`«${name.toUpperCase()}» НА НЕСКОЛЬКИХ ХОСТАХ — УТОЧНИ: DATA <HOST> CP ${name.toUpperCase()}`)
      return null
    }
    this.toast(`НЕТ ТАКИХ ДАННЫХ — DATA LS ПОКАЖЕТ СПИСОК`)
    return null
  }

  /** ls: листинг прямо в палитре (§16.2 «терминал») — палитра не закрывается.
   *  Явный хост — переключение цели (плейтест: «data ls t1 — по сути это
   *  переключение цели»): дальше софт 1–6 жал на тот же хост. */
  private execDataLs(host: string, raw: string): void {
    const pal = this.palette
    if (pal === null) return
    if (host !== 'deck') this.target = host
    if (pal.input !== null && pal.input.value.trim() !== raw) pal.input.value = raw
    if (this.cmdHistory[this.cmdHistory.length - 1] !== raw && raw !== '') {
      this.cmdHistory.push(raw)
      if (this.cmdHistory.length > 20) this.cmdHistory.shift()
    }
    this.histIdx = 0
    this.paletteLs = host
    this.paletteSel = -1
    this.updatePalette()
  }

  /** Запуск `data …` (§16.2): [host] sub key [dst] после токена data;
   *  prefixHost — хост из обратного порядка «t1 data …». */
  private runDataCmd(args: string[], prefixHost: string | null): void {
    const pal = this.palette
    if (pal === null || pal.input === null) return
    const a = args.map((t) => t.toLowerCase())
    let host: string | null = prefixHost
    let i = 0
    if (host === null && a.length > 0 && this.dataHostAt(a[0]) !== null) {
      host = this.dataHostAt(a[0])
      i = 1
    }
    const sub = a[i] !== undefined && (DATA_SUBS as readonly string[]).includes(a[i]) ? (a[i] as DataSub) : undefined
    if (sub === undefined) {
      // `data [host]` без подкоманды = ls (кнопка 7 даёт ровно это)
      if (a.length - i === 0) {
        this.execDataLs(host ?? this.dataCtxHost(), pal.input.value.trim())
        return
      }
      this.toast('ПОДКОМАНДА: LS / CP / MV / RM / DECRYPT — TAB ПОКАЖЕТ СПИСОК')
      return
    }
    const keyTok = a[i + 1]
    if (sub === 'ls') {
      // data ls [host] — хост может стоять и ПОСЛЕ подкоманды (плейтест:
      // «data ls localhost» молча валился в контекст активного таба)
      const rest = a.slice(i + 1)
      if (rest.length > 0) {
        const dh = this.dataHostAt(rest[0])
        if (dh === null) {
          this.toast('НЕТ ТАКОГО ХОСТА — TAB ПОКАЖЕТ СПИСОК')
          return
        }
        host = dh
      }
      this.execDataLs(host ?? this.dataCtxHost(), pal.input.value.trim())
      return
    }
    if (keyTok === undefined) {
      // fast-path: на источнике ровно один item — старт сразу (как кнопка)
      const h = host ?? this.dataCtxHost()
      const items = this.dataHostItems(h)
      if ((sub === 'cp' || sub === 'mv') && h === 'deck') {
        this.toast('С ДЕКИ — УКАЖИ ПРИЁМНИК: DATA CP/MV <KEY> <HOST>')
        return
      }
      if (items.length === 1) {
        this.sendData(sub, h, items[0].n, 'deck')
        this.pushHistoryClose(pal.input.value.trim())
      } else {
        this.toast(`УКАЖИ КЛЮЧ — ${items.length === 0 ? 'ДАННЫХ НЕТ' : 'TAB ПОКАЖЕТ СПИСОК'}`)
      }
      return
    }
    const at = keyTok.indexOf('@')
    const name = at >= 0 ? keyTok.slice(0, at) : keyTok
    const src = this.resolveDataSrc(name, at >= 0 ? this.dataHostAt(keyTok.slice(at + 1)) : host)
    if (src === null) return
    if (sub === 'rm' || sub === 'decrypt') {
      // rm и decrypt — одноаргументные: приёмника нет (§16.2/§16.4)
      this.sendData(sub, src.host, src.key, null)
      this.pushHistoryClose(pal.input.value.trim())
      return
    }
    let dst = 'deck'
    if (a[i + 2] !== undefined) {
      const dh = this.dataHostAt(a[i + 2])
      if (dh === null) {
        this.toast('НЕТ ТАКОГО ПРИЁМНИКА — TAB ПОКАЖЕТ СПИСОК')
        return
      }
      dst = dh
    }
    if (dst === src.host) {
      this.toast('ИСТОЧНИК = ПРИЁМНИК')
      return
    }
    this.sendData('cp', src.host, src.key, dst)
    this.pushHistoryClose(pal.input.value.trim())
  }

  /** Отправка cp/mv/rm + тост (короткий путь для палитры, дерева и кнопок).
   *  cp/mv — анимированный тост-прогресс (§16.2), живёт до финиша/отмены. */
  private sendData(sub: 'cp' | 'mv' | 'rm' | 'decrypt', src: string, key: string, dst: string | null): void {
    if (sub === 'rm') {
      this.deps.send({ t: 'run', prog: 'rm', dev: src, data: key })
      this.toast(`RM ${key.toUpperCase()}${src === 'deck' ? ' (ДЕКА)' : ` @${src.toUpperCase()}`}`)
      return
    }
    if (sub === 'decrypt') {
      // §16.4: джоба decrypt — тот же «хост данных»; тост внутри sendDecrypt
      this.sendDecrypt(src, key)
      return
    }
    const realDst = dst ?? 'deck'
    this.deps.send({ t: 'run', prog: sub, dev: src, dst: realDst, data: key })
    this.cpToastStart(sub, src, realDst, key, this.dataHostItems(src).find((it) => it.n === key)?.mb ?? 0)
  }

  /** Анимированный cp-тост: полоса с бегущими полосками, объём/скорость
   *  обновляются из deck-сообщения (updateCpToasts), финиш — «ГОТОВО ✓»
   *  (зелёный), отмена (denied cp_cancel) — «ПРЕРВАНО» (красный). */
  private cpToastStart(prog: 'cp' | 'mv', src: string, dst: string, key: string, mb: number): void {
    const wrap = el('div', 'hv-toast hv-cptoast')
    const row = el('div', 'cprow')
    row.append(
      txt('span', 'cptitle', `${prog.toUpperCase()} ${key.toUpperCase()}${src === 'deck' ? ' · ДЕКА' : ` · ${src.toUpperCase()}`}`),
      txt('span', 'cpdst', dst === 'deck' ? '→ ДЕКА' : `→ ${dst.toUpperCase()}`),
    )
    const bar = el('div', 'cpbar')
    const fill = el('div', 'cpbar-fill')
    bar.append(fill)
    const status = txt('div', 'cpstatus', mb > 0 ? `${mb} МБ` : 'ПЕРЕДАЧА…')
    wrap.append(row, bar, status)
    this.toasts.append(wrap)
    this.cpToasts.push({ key: `${prog}:${src}>${dst}/${key}`, prog, dev: src, dst, data: key, mb, wrap, fill, status, missed: 0, seen: false })
    this.capToasts() // §15.30
  }

  /** 2 Гц: прогресс активных cp/mv-тостов из deck-сообщения. Два тика без
   *  процесса: карточка, видевшая прогресс — завершена (зелёная «ГОТОВО ✓»);
   *  ни разу не видевшая — сервер отказал на старте: ТА ЖЕ карточка краснеет
   *  и мигает (плейтест: «два прогрессбара — зеленый 100% и красный ниже» —
   *  отказ обязан красить существующую карточку, а не плодить вторую). */
  private updateCpToasts(): void {
    for (const r of [...this.cpToasts]) {
      const p = this.progs.find(
        (q) => q.prog === r.prog && q.dev === r.dev && q.dst === r.dst && q.data === r.data,
      )
      if (p !== undefined) {
        r.seen = true
        r.missed = 0
        const left = p.mbLeft ?? r.mb
        const mbps = p.mbps ?? 0
        const done = r.mb > 0 ? Math.min(1, (r.mb - left) / r.mb) : 0.15
        r.fill.style.width = `${Math.round(done * 100)}%`
        r.status.textContent = `${left} МБ · ${Math.round(mbps)} МБ/С`
        continue
      }
      r.missed += 1
      if (r.missed < 2) continue
      this.cpToasts = this.cpToasts.filter((x) => x !== r)
      if (r.seen) {
        r.wrap.classList.add('ok')
        r.fill.style.width = '100%'
        r.status.textContent = 'ГОТОВО ✓'
        this.fadeCard(r.wrap, 1300)
      } else {
        this.failCard(r, 'НЕ ЗАПУЩЕНО СЕРВЕРОМ')
      }
    }
    // DECRYPT-карточки (дека): прогресс из deck-сообщения — ВНЕ цикла по
    // cp-тостам: внутри цикла вызывался только пока существуют cp-тосты,
    // и дековый decrypt без cp висел на 0% (плейтест).
    this.updateJobCards()
    // Скан-карточки — тот же принцип (вне цикла, каждый deck-тик).
    this.updateScanCards()
  }

  /** Покраснить карточку отказа: красный мигающий бар + причина (§16.2). */
  private failCard(r: (typeof this.cpToasts)[number], text: string): void {
    r.wrap.classList.add('fail')
    r.fill.style.width = '100%'
    r.status.textContent = `ОТКАЗ: ${text}`
    this.fadeCard(r.wrap, 2200)
  }

  private fadeCard(wrap: HTMLElement, ms: number): void {
    window.setTimeout(() => {
      wrap.classList.add('fade')
      window.setTimeout(() => wrap.remove(), 500)
    }, ms)
  }

  /** denied cp_cancel (§16.2): активные cp-тосты источника — красным. */
  private failCpToasts(dev: string): void {
    for (const r of [...this.cpToasts]) {
      if (r.dev !== dev) continue
      r.wrap.classList.add('fail')
      r.fill.style.width = '100%'
      r.status.textContent = 'ОТКАЗ — ПРОГРЕСС ПОТЕРЯН'
      this.cpToasts = this.cpToasts.filter((x) => x !== r)
      this.fadeCard(r.wrap, 2200)
    }
  }

  /** Отправка decrypt (§16.4): джоба на хосте, где лежат данные. Карточка
   *  создаётся сразу (плеер видит, что стартовало); прогресс придёт из
   *  deck-сообщения (дека, 2 Гц) или job 1 Гц (SRV, команде). */
  private sendDecrypt(src: string, key: string): void {
    this.deps.send({ t: 'run', prog: 'decrypt', dev: src, data: key })
    this.jobCardStart(`decrypt:${src}/${key}`, src, key)
  }

  /** DECRYPT-карточка: голубой NPU-бар с плавным ходом (CSS transition
   *  сглаживает 1 Гц job / 2 Гц deck), крупный процент и бегущая hex-строка —
   *  визуально «расшифровка», а не полоска трансфера (плейтест: «скучно»). */
  private jobCardStart(key: string, dev: string, data: string): (typeof this.jobCards)[number] {
    const wrap = el('div', 'hv-toast hv-cptoast dec')
    const row = el('div', 'cprow')
    row.append(
      txt('span', 'cptitle', `DECRYPT ${data.toUpperCase()}`),
      txt('span', 'cpdst', `· ${dev === 'deck' ? 'ДЕКА · NPU ×1' : `${dev.toUpperCase()} · NPU ×3`}`),
    )
    const bar = el('div', 'cpbar')
    const fill = el('div', 'cpbar-fill')
    fill.style.width = '0%'
    bar.append(fill)
    const meta = el('div', 'decmeta')
    const pct = txt('span', 'decpct', '0%')
    const scr = txt('span', 'decscr', '')
    meta.append(pct, scr)
    wrap.append(row, bar, meta)
    this.toasts.append(wrap)
    const rec: (typeof this.jobCards)[number] = {
      key, dev, data, wrap, fill, pct, scr, seen: false, missed: 0, timer: 0,
    }
    // hex-скрэмбл: «работа NPU» — интервал гасится только с карточкой
    const HEX = '0123456789abcdef'
    rec.timer = window.setInterval(() => {
      let s = ''
      for (let i = 0; i < 16; i++) s += HEX[Math.floor(Math.random() * 16)]
      rec.scr.textContent = s
    }, 70)
    this.jobCards.push(rec)
    this.capToasts() // §15.30
    return rec
  }

  private jobCardProgress(rec: (typeof this.jobCards)[number], p: number): void {
    rec.seen = true
    rec.missed = 0
    const v = Math.min(1, Math.max(0, p))
    rec.fill.style.width = `${Math.round(v * 100)}%`
    rec.pct.textContent = `${Math.round(v * 100)}%`
  }

  private jobCardFinish(rec: (typeof this.jobCards)[number], ok: boolean): void {
    window.clearInterval(rec.timer)
    rec.wrap.classList.add(ok ? 'ok' : 'fail')
    rec.fill.style.width = '100%'
    if (ok) {
      rec.pct.textContent = '100%'
      rec.scr.textContent = '▸ ГОТОВО ✓ — КОД У КОМАНДЫ'
    } else {
      rec.scr.textContent = '▸ ОТКАЗ ✗'
    }
    this.jobCards = this.jobCards.filter((x) => x !== rec)
    this.fadeCard(rec.wrap, ok ? 1600 : 2400)
  }

  /** job 1 Гц (§16.9): прогресс SRV-decrypt — та же DECRYPT-карточка.
   *  Приходит КОМАНДЕ (и после джек-аута/смерти запустившего); prog=1 —
   *  «ГОТОВО ✓» (код уже у команды — codes/HUD). */
  onJob(msg: { dev: string; data: string; prog: number }): void {
    if (!this._active) return
    const key = `decrypt:${msg.dev}/${msg.data}`
    let r = this.jobCards.find((x) => x.key === key)
    if (r === undefined) r = this.jobCardStart(key, msg.dev, msg.data)
    if (msg.prog >= 1) {
      this.jobCardFinish(r, true)
      return
    }
    this.jobCardProgress(r, msg.prog)
  }

  /** Дековые DECRYPT-джобы: МБ-прогресс из deck-сообщения 2 Гц; два тика
   *  без процесса — джоба кончилась (финиш/отказ на старте — как у cp). */
  private updateJobCards(): void {
    for (const r of [...this.jobCards]) {
      if (r.dev !== 'deck') continue // SRV-джобы идут через job 1 Гц
      const mb = this.deckData.find((it) => it.n === r.data)?.mb ?? 0
      const p = this.progs.find((q) => q.prog === 'decrypt' && q.data === r.data)
      if (p !== undefined && mb > 0 && p.mbLeft !== undefined) {
        this.jobCardProgress(r, 1 - p.mbLeft / mb)
        continue
      }
      r.missed += 1
      if (r.missed < 2) continue
      this.jobCardFinish(r, r.seen)
    }
  }

  private pushHistoryClose(raw: string): void {
    if (this.cmdHistory[this.cmdHistory.length - 1] !== raw && raw !== '') {
      this.cmdHistory.push(raw)
      if (this.cmdHistory.length > 20) this.cmdHistory.shift()
    }
    this.histIdx = 0
    this.closePalette()
  }

  /** §15.30 (ревебр owner: «баблы справа загораживают палитру команд»):
   *  на тапе не более трёх job-карточек одновременно — старшая гаснет
   *  (display:none, логика доживает в фоне до финиша), освободив угол. */
  private capToasts(): void {
    if (!IS_TOUCH) return
    const vis = [...this.toasts.children].filter((c) => (c as HTMLElement).style.display !== 'none')
    for (let i = 0; i < vis.length - 3; i++) (vis[i] as HTMLElement).style.display = 'none'
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
    if (pal.input === null) {
      // Дерево на тапе (§15.7): клавиатуры нет, только ESC/× закрывают.
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closePalette()
      }
      return
    }
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
    // Стрелки — ТОЛЬКО подсветка кандидата (плейтест M5: «вниз сразу
    // выбирает первый объект, когда их три»); ввод не трогаем — дописывание
    // токена осталось за Tab, запуск подсвеченного — Enter.
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      this.paletteMove(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (pal.input.value.trim() === '') this.recallHistory()
      else this.paletteMove(-1)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      this.paletteCycle(1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      this.paletteRun()
    }
    // Раскладка не латинская → клавиши Key[A-Z] вводим латиницей по физкоду
    // (плейтест M5, desktop): тестировать палитру с русской раскладкой было
    // нельзя, вводился мусор вместо токенов — см. latinForKey().
    const ch = latinForKey(e)
    if (ch !== null) {
      e.preventDefault()
      const v = pal.input.value
      const s = pal.input.selectionStart ?? v.length
      const en = pal.input.selectionEnd ?? s
      pal.input.value = v.slice(0, s) + ch + v.slice(en)
      const pos = s + ch.length
      pal.input.setSelectionRange(pos, pos)
      this.paletteSel = -1
      this.updatePalette()
      return
    }
    // Остальное — обычный ввод в строку фильтра (input-событие обновит список).
  }

  /** seedDev (тап-палитра из таба, §15.17): дерево сразу на уровне программ
   *  этого устройства — «внутри таба» есть чем запустить софт, аналог
   *  десктопной «/<dev> <prog>». */
  private openPalette(mode: 'run' | 'tab', seedDev: string | null = null): void {
    if (this.palette !== null) return
    this.paletteMode = mode
    this.paletteDev = mode === 'run' ? seedDev : null
    this.paletteLs = null
    this.paletteDataHost = null
    this.paletteDataItem = null
    const wrap = el('div', 'hv-palette')
    const list = el('div', 'hv-pal-list')
    if (IS_TOUCH) {
      // Режебр owner (§15.7): системную клавиатуру iOS/Android веб уменьшить
      // не может, а она съедала до 90% экрана — поэтому на тапе поля ввода
      // нет вовсе: дерево кнопок «устройство → программа». Клавиатура не
      // вызывается, потому что фокусить нечему.
      const hint = el('div', 'hv-pal-hint')
      hint.textContent = '× ЗАКРЫТЬ'
      const x = el('button', 'hv-pal-x')
      x.textContent = '×'
      x.setAttribute('aria-label', 'закрыть')
      x.addEventListener('click', () => this.closePalette())
      hint.append(x)
      wrap.append(list, hint)
      this.root.append(wrap)
      this.palette = { wrap, input: null, list }
      this.updatePalette()
      return
    }
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'hv-pal-input'
    input.autocomplete = 'off'
    input.spellcheck = false
    // Enter на экранной клавиатуре = «Поиск» (запуск), не перевод строки (§15.2)
    input.enterKeyHint = 'search'
    input.placeholder =
      mode === 'tab'
        ? 'фильтр устройства — напр. cam2, ENTER ОТКРЫТЬ ТАБ'
        : 'цель и/или программа — напр. cam1 port · portscan cam1'
    input.addEventListener('input', () => {
      this.paletteSel = -1
      this.paletteLs = null // ручной ввод покидает ls-листинг (§16.2)
      this.updatePalette()
    })
    const hint = el('div', 'hv-pal-hint')
    hint.textContent =
      mode === 'tab'
        ? 'TAB ДОПОЛНИТЬ · ↑↓ ВЫБОР · ENTER ОТКРЫТЬ ТАБ · ESC ЗАКРЫТЬ'
        : 'TAB ДОПОЛНИТЬ · ↑↓ ВЫБОР · ↑ ИСТОРИЯ · ENTER ВСТАВИТЬ/ЗАПУСК · ESC ЗАКРЫТЬ'
    wrap.append(input, list, hint)
    this.root.append(wrap)
    this.palette = { wrap, input, list }
    this.paletteSel = -1
    this.histIdx = 0
    this.updatePalette()
    input.focus()
  }

  /** Префикс-группа id для чипов touch-палитры (§15.25): ведущая буквенная
   *  часть id в верхнем регистре — cam1→CAM, srv2→SRV, s1→S, t3→T, d4→D,
   *  k3o→K. Цифросодержащие id без букв (не бывает в этой карте) — «ПРОЧИЕ». */
  private devGroup(id: string): string {
    const m = /^([a-z]+)/i.exec(id)
    return m !== null ? m[1].toUpperCase() : 'ПРОЧИЕ'
  }

  /** Уровень устройств палитры-дерева (touch, §15.7): PORTSCAN по всей сети
   *  + устройство → следующий уровень (или сразу таб в режиме 'tab').
   *  §15.25: когда групп ≥2, верхний уровень — чипы префиксов (CAM/SRV/S/…),
   *  а не плоский список из 25+ кнопок. */
  private paletteTreeDevs(pal: NonNullable<HackView['palette']>): void {
    const { list } = pal
    const all = [...this.devices.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    if (this.paletteMode === 'run') {
      const b = el('button', 'hv-pal-cand hv-pal-dev')
      b.append(
        txt('span', 'hv-pal-name', 'PORTSCAN — ВСЯ СЕТЬ'),
        txt('span', 'hv-pal-hintc', 'РАЗВЕДКА'),
      )
      b.addEventListener('click', () => this.paletteTreeRun('portscan', null))
      list.append(b)
      // §16.2: данные деки — уровень items прямо из корня
      if (this.deckData.length > 0) {
        const d = el('button', 'hv-pal-cand hv-pal-dev')
        d.append(
          txt('span', 'hv-pal-name', `ДЕКА: ДАННЫЕ (${this.deckData.length})`),
          txt('span', 'hv-pal-hintc', `${this.deckMemUsed}/${this.deckMemCap} МБ`),
        )
        d.addEventListener('click', () => {
          this.paletteDataHost = 'deck'
          this.updatePalette()
        })
        list.append(d)
      }
    }
    if (all.length === 0) {
      list.append(txt('div', 'hv-dim', 'СЕТЬ ПУСТА — НАЖМИ PORTSCAN ВЫШЕ'))
      return
    }
    // §15.25: карта групп → чипы. Порядок чипов = алфавит по префиксу.
    const groups = new Map<string, ScanDevice[]>()
    for (const d of all) {
      const g = this.devGroup(d.id)
      const arr = groups.get(g)
      if (arr === undefined) groups.set(g, [d])
      else arr.push(d)
    }
    const keys = [...groups.keys()].sort()
    if (keys.length >= 2 && this.paletteGroup === null) {
      const row = el('div', 'hv-pal-chips')
      for (const g of keys) {
        const c = el('button', 'hv-pal-chip')
        c.append(txt('span', 'hv-pal-chipn', g), txt('span', 'hv-pal-chipc', String(groups.get(g)!.length)))
        c.addEventListener('click', () => {
          this.paletteGroup = g
          this.updatePalette()
        })
        row.append(c)
      }
      list.append(row)
      list.append(txt('div', 'hv-pal-more', 'ГРУППА — ЧИПОМ ВЫШЕ'))
      return
    }
    if (keys.length >= 2 && this.paletteGroup !== null && groups.has(this.paletteGroup)) {
      const back = el('button', 'hv-pal-cand hv-pal-back')
      back.append(txt('span', 'hv-pal-name', '← ВСЕ ГРУППЫ'), txt('span', 'hv-pal-hintc', `${all.length} устр.`))
      back.addEventListener('click', () => {
        this.paletteGroup = null
        this.updatePalette()
      })
      list.append(back)
    }
    const shown =
      keys.length >= 2 && this.paletteGroup !== null && groups.has(this.paletteGroup)
        ? groups.get(this.paletteGroup)!
        : all
    for (const d of shown) {
      const b = el('button', 'hv-pal-cand hv-pal-dev')
      const name = txt('span', 'hv-pal-name', `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`)
      b.append(name)
      // §15.28: hint окрашен bucket'ом владения, кроме «УЖЕ В ТАБАХ» (это
      // статус таба, не владение) — там прежняя тусклая подпись.
      const tabbed = this.paletteMode === 'tab' && this.tabs.some((t) => t.dev === d.id)
      const hintSpan = txt('span', 'hv-pal-hintc', this.paletteMode === 'tab' ? this.tabHint(d) : this.ownerLabel(d.owner))
      if (!tabbed) hintSpan.classList.add(this.palOwnerCls(d.owner))
      b.append(hintSpan)
      b.addEventListener('click', () => {
        if (this.paletteMode === 'tab') {
          this.ensureTab(d.id, true)
          this.closePalette()
          this.toast(`ТАБ: ${d.id.toUpperCase()}`)
          this.schedule(() => this.render())
          return
        }
        this.paletteDev = d.id
        this.updatePalette()
      })
      list.append(b)
    }
  }

  /** Уровень программ палитры-дерева (touch, §15.7): назад + шесть программ
   *  с подсказкой готовности (та же логика, что у второго токена строки). */
  private paletteTreeProgs(pal: NonNullable<HackView['palette']>, dev: string): void {
    const { list } = pal
    const back = el('button', 'hv-pal-cand hv-pal-back')
    back.append(txt('span', 'hv-pal-name', '← НАЗАД'), txt('span', 'hv-pal-hintc', 'УСТРОЙСТВА'))
    back.addEventListener('click', () => {
      this.paletteDev = null
      this.updatePalette()
    })
    list.append(back)
    const d = this.devices.get(dev)
    // §16.2: свои данные на устройстве — уровень items (CP → приёмник / RM)
    const items = this.dataHostItems(dev)
    if (items.length > 0) {
      const dr = el('button', 'hv-pal-cand hv-pal-data')
      dr.append(
        txt('span', 'hv-pal-name', `ДАННЫЕ (${items.length})`),
        txt('span', 'hv-pal-hintc', 'LS / CP / RM'),
      )
      dr.addEventListener('click', () => {
        this.paletteDataHost = dev
        this.updatePalette()
      })
      list.append(dr)
    }
    for (const p of PALETTE_PROGS) {
      const b = el('button', 'hv-pal-cand')
      b.append(txt('span', 'hv-pal-name', PROG_LABEL[p]), txt('span', 'hv-pal-hintc', this.paletteProgHint(p, d)))
      b.addEventListener('click', () => this.paletteTreeRun(p, dev))
      list.append(b)
    }
  }

  /** Подсказка готовности программы — тот же смысл, что у второго токена. */
  private paletteProgHint(p: RunProg, d: ScanDevice | undefined): string {
    if (p === 'portscan') return 'РАЗВЕДКА'
    if (d === undefined) return '—'
    if (p === 'trojan' && !d.vulned) return 'СНАЧАЛА VULNSCAN'
    return 'ГОТОВО'
  }

  private paletteTreeRun(prog: RunProg, dev: string | null): void {
    this.closePalette()
    this.runProgAt(prog, dev)
  }

  /** Уровень items дерева (touch, §16.2): назад + шапка MEM + строки данных
   *  с кнопками CP (→ приёмник) и 🗑 RM (сразу). */
  private paletteTreeItems(pal: NonNullable<HackView['palette']>, host: string): void {
    const { list } = pal
    const back = el('button', 'hv-pal-cand hv-pal-back')
    back.append(
      txt('span', 'hv-pal-name', '← НАЗАД'),
      txt('span', 'hv-pal-hintc', host === 'deck' ? 'КОРЕНЬ' : 'ПРОГРАММЫ'),
    )
    back.addEventListener('click', () => {
      this.paletteDataHost = null
      this.updatePalette()
    })
    list.append(back)
    const mem = this.dataHostMem(host)
    list.append(txt('div', 'hv-pal-lshead', `${this.dataHostLabel(host)}${mem !== '' ? ` · MEM ${mem}` : ''}`))
    const items = this.dataHostItems(host)
    if (items.length === 0) {
      list.append(txt('div', 'hv-dim', 'ДАННЫХ НЕТ'))
      return
    }
    for (const it of items) {
      const row = el('div', 'hv-pal-cand hv-pal-item')
      row.append(
        txt(
          'span',
          'hv-pal-name',
          `${it.n} ${it.mb}МБ${it.enc ? ' 🔒' : ''}${it.code !== undefined ? ` код ${it.code}` : ''}`,
        ),
      )
      const cp = el('button', 'dev-link')
      cp.textContent = 'CP'
      cp.title = 'копия (источник хранит свой экземпляр)'
      cp.addEventListener('click', (e) => {
        e.stopPropagation()
        this.paletteDataItem = { host, key: it.n, prog: 'cp' }
        this.updatePalette()
      })
      const mv = el('button', 'dev-link')
      mv.textContent = 'MV'
      mv.title = 'перенос (item уходит из источника)'
      mv.addEventListener('click', (e) => {
        e.stopPropagation()
        this.paletteDataItem = { host, key: it.n, prog: 'mv' }
        this.updatePalette()
      })
      const rm = el('button', 'dev-link')
      rm.textContent = '🗑'
      rm.addEventListener('click', (e) => {
        e.stopPropagation()
        this.closePalette()
        this.sendData('rm', host, it.n, null)
      })
      if (it.enc) {
        // §16.4: decrypt прямо из ls-строки (джоба на хосте данных)
        const dc = el('button', 'dev-link')
        dc.textContent = '🔓'
        dc.title = `data decrypt ${it.n} (NPU)`
        dc.addEventListener('click', (e) => {
          e.stopPropagation()
          this.closePalette()
          this.sendDecrypt(host, it.n)
        })
        row.append(dc)
      }
      row.append(cp, mv, rm)
      list.append(row)
    }
  }

  /** Уровень приёмника cp дерева (touch, §16.2): назад + ДЕКА + свои хосты. */
  private paletteTreeDst(pal: NonNullable<HackView['palette']>): void {
    const item = this.paletteDataItem
    if (item === null) return
    const { list } = pal
    const back = el('button', 'hv-pal-cand hv-pal-back')
    back.append(txt('span', 'hv-pal-name', '← НАЗАД'), txt('span', 'hv-pal-hintc', 'ДАННЫЕ'))
    back.addEventListener('click', () => {
      this.paletteDataItem = null
      this.updatePalette()
    })
    list.append(back)
    list.append(txt('div', 'hv-pal-lshead', `${item.prog.toUpperCase()} ${item.key.toUpperCase()} → ?`))
    if (item.host !== 'deck') {
      const deck = el('button', 'hv-pal-cand hv-pal-dev')
      deck.append(txt('span', 'hv-pal-name', 'ДЕКА'), txt('span', 'hv-pal-hintc', 'ЭКСФИЛЬТРАЦИЯ'))
      deck.addEventListener('click', () => {
        this.closePalette()
        this.sendData(item.prog, item.host, item.key, 'deck')
      })
      list.append(deck)
    }
    const owned = [...this.devices.values()]
      .filter((d) => d.owner === this.myId && d.id !== item.host)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    for (const d of owned) {
      const b = el('button', 'hv-pal-cand hv-pal-dev')
      b.append(
        txt('span', 'hv-pal-name', `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`),
        (() => {
          // §15.28: приёмник cp всегда «свой» — MEM-строка не владелец, не красим
          const s = txt('span', 'hv-pal-hintc', d.mem !== undefined ? `${d.mem - (d.memFree ?? 0)}/${d.mem} МБ` : this.ownerLabel(d.owner))
          if (d.mem === undefined) s.classList.add(this.palOwnerCls(d.owner))
          return s
        })(),
      )
      b.addEventListener('click', () => {
        this.closePalette()
        this.sendData(item.prog, item.host, item.key, d.id)
      })
      list.append(b)
    }
    if (item.host === 'deck' && owned.length === 0) {
      list.append(txt('div', 'hv-dim', 'НЕТ СВОИХ ХОСТОВ — CP ТОЛЬКО С ДЕКИ НА ХОСТ'))
    }
  }

  private closePalette(): void {
    if (this.palette === null) return
    // Touch: снять фокус, иначе экранная клавиатура останется висеть (§15.2).
    // В дереве (§15.7) фокуса нет вовсе — input === null.
    this.palette.input?.blur()
    this.palette.wrap.remove()
    this.palette = null
    this.paletteCands = []
    this.paletteSel = -1
    this.paletteLs = null
    this.paletteGroup = null
    this.paletteDataHost = null
    this.paletteDataItem = null
  }

  /** Устройство подходит под токен: совпадение по НАЧАЛУ строки в id/kind
   *  (с алиасами term/cam); пустой токен подходит всем (§13.3). Префикс, а
   *  не подстрока — иначе «d1 t» даёт portscan раньше trojan. */
  private devMatch(d: ScanDevice, q: string): boolean {
    if (q === '') return true
    const alias = KIND_ALIAS[q]
    return d.id.startsWith(q) || d.kind.startsWith(q) || (alias !== undefined && d.kind === alias)
  }

  /** Кандидаты-подкоманды data (§16.2). */
  private dataSubCands(q: string, subs: readonly DataSub[] = DATA_SUBS): PalCand[] {
    const hints: Record<DataSub, string> = { ls: 'ЛИСТИНГ', cp: 'КОПИЯ', mv: 'ПЕРЕНОС', rm: 'УДАЛИТЬ', decrypt: 'NPU-РАСШИФРОВКА' }
    return subs
      .filter((s) => s.startsWith(q) || q === '')
      .map((s) => ({ kind: 'sub' as const, text: s, label: s.toUpperCase(), hint: hints[s] }))
  }

  /** Кандидаты-хосты data (§16.2): дека + устройства; dst-режим — только
   *  свои (приёмник cp должен быть под контролем). */
  private dataHostCands(q: string, ownedOnly: boolean): PalCand[] {
    const out: PalCand[] = []
    if (q === '' || 'deck'.startsWith(q)) {
      out.push({
        kind: 'dev',
        text: 'deck',
        dev: 'deck',
        label: 'ДЕКА',
        hint: `${this.deckMemUsed}/${this.deckMemCap} МБ`,
      })
    }
    // Алиас localhost (плейтест): в списке — только когда его явно пишут,
    // чтобы не дублировать ДЕКУ на пустом запросе.
    if (q !== '' && 'localhost'.startsWith(q)) {
      out.push({
        kind: 'dev',
        text: 'localhost',
        dev: 'deck',
        label: 'ЛОКАЛХОСТ = ДЕКА',
        hint: `${this.deckMemUsed}/${this.deckMemCap} МБ`,
      })
    }
    const devs = [...this.devices.values()]
      .filter((d) => this.devMatch(d, q) && (!ownedOnly || d.owner === this.myId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    for (const d of devs) {
      out.push({
        kind: 'dev',
        text: d.id,
        dev: d.id,
        label: `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`,
        hint: ownedOnly && d.mem !== undefined ? `${d.mem - (d.memFree ?? 0)}/${d.mem} МБ` : this.ownerLabel(d.owner),
        // §15.28: MEM-подсказка приёмника cp — не владение, не красим
        owner: ownedOnly && d.mem !== undefined ? undefined : d.owner,
      })
    }
    return out
  }

  /** Кандидаты-ключи (§16.2): свои источники; если один ключ лежит на
   *  нескольких хостах — токен name@host (уточнение источника). */
  /** Имя item'а для вставки в строку: при дубликатах имени на разных хостах —
   *  с суффиксом @host (однозначный выбор, решение владельца 2026-11-20:
   *  «ENTER на 06_19 — не подставилось?» → выбор обязан быть однозначным).
   *  runDataCmd/reverse-форма разбирают key@host так же. */
  private itemText(name: string, host: string): string {
    let n = 0
    for (const s of this.dataSources()) for (const it of s.items) if (it.n === name) n++
    return n > 1 ? `${name}@${host}` : name
  }

  private dataKeyCands(q: string, host: string | null): PalCand[] {
    const out: PalCand[] = []
    const seen = new Set<string>()
    const srcs = host !== null ? [{ host, items: this.dataHostItems(host) }] : this.dataSources()
    for (const s of srcs) {
      for (const it of s.items) {
        const text = this.itemText(it.n, s.host)
        if (seen.has(text)) continue
        if (q !== '' && !it.n.toLowerCase().startsWith(q) && !text.toLowerCase().startsWith(q)) continue
        seen.add(text)
        out.push({
          kind: 'item',
          text,
          dev: s.host,
          data: it.n,
          label: `${it.n.toUpperCase()} ${it.mb}МБ${it.enc ? ' 🔒' : ''}`,
          hint: s.host === 'deck' ? '@ДЕКА' : `@${s.host.toUpperCase()}`,
        })
      }
    }
    return out.sort((a, b) => (a.text < b.text ? -1 : 1))
  }

  /** Тихая резолвция источника (для фильтров/подсказок, без тостов). */
  private dataSrcOf(nameTok: string, host: string | null): string | null {
    const at = nameTok.indexOf('@')
    const name = at >= 0 ? nameTok.slice(0, at) : nameTok
    const h = at >= 0 ? this.dataHostAt(nameTok.slice(at + 1)) : host
    if (h !== null) return this.dataHostItems(h).some((it) => it.n === name) ? h : null
    const active = this.dataCtxHost()
    const srcs = this.dataSources().filter((s) => s.items.some((it) => it.n === name))
    const pick = srcs.find((s) => s.host === active) ?? srcs.find((s) => s.host === 'deck')
    if (pick !== undefined) return pick.host
    return srcs.length === 1 ? srcs[0].host : null
  }

  /** Кандидаты аргументов `data …` (§16.2): [host] sub key [dst]. prev —
   *  уже введённые токены после 'data', q — дописываемый; prefixHost — хост
   *  из порядка «t1 data …». */
  private dataCands(prev: string[], q: string, prefixHost: string | null): PalCand[] {
    let host = prefixHost
    let i = 0
    if (host === null && prev.length > 0 && this.dataHostAt(prev[0]) !== null) {
      host = this.dataHostAt(prev[0])
      i = 1
    }
    const sub =
      prev[i] !== undefined && (DATA_SUBS as readonly string[]).includes(prev[i]) ? (prev[i] as DataSub) : undefined
    if (sub === undefined) {
      if (host !== null) return this.dataSubCands(q)
      return [...this.dataHostCands(q, false), ...this.dataSubCands(q)]
    }
    if (sub === 'ls') return this.dataHostCands(q, false) // data ls [host]
    const keyTok = prev[i + 1]
    if (keyTok === undefined) return this.dataKeyCands(q, host)
    if (sub === 'rm' || sub === 'decrypt') return []
    const src = this.dataSrcOf(keyTok, host)
    return this.dataHostCands(q, true).filter((c) => c.dev !== src)
  }

  /** ls-листинг прямо в палитре (§16.2 «терминал», решение владельца):
   *  шапка хоста/MEM + строки-кандидаты; Enter на строке — заготовка cp. */
  private paletteLsRender(pal: NonNullable<HackView['palette']>): void {
    const host = this.paletteLs
    if (host === null) return
    const d = host === 'deck' ? undefined : this.devices.get(host)
    const owner = host === 'deck' || d?.owner === this.myId
    const items = this.dataHostItems(host)
    this.paletteCands = items.map((it) => ({
      kind: 'item' as const,
      text: it.n,
      dev: host,
      data: it.n,
      label: `${it.n} ${it.mb}МБ${it.enc ? ' 🔒' : ''}${it.code !== undefined ? ` код ${it.code}` : ''}`,
      hint: 'CP/MV/RM' + (it.enc ? '/🔓' : ''),
    }))
    if (this.paletteSel >= items.length) this.paletteSel = items.length - 1
    pal.list.replaceChildren()
    const mem = this.dataHostMem(host)
    pal.list.append(txt('div', 'hv-pal-lshead', `${this.dataHostLabel(host)}${mem !== '' ? ` · MEM ${mem}` : ''}`))
    if (!owner) {
      // Доступ — это ошибка, а не подсказка: красным (плейтест: «надо красным
      // показать, что для данных нужен trojan на цели»)
      pal.list.append(txt('div', 'hv-pal-red', 'ДОСТУП ЗАПРЕЩЁН — НУЖЕН TROJAN НА ЦЕЛИ'))
      return
    }
    if (items.length === 0) {
      pal.list.append(txt('div', 'hv-dim', 'ДАННЫХ НЕТ'))
      return
    }
    this.paletteCands.forEach((c, i) => {
      const row = el('div', 'hv-pal-cand' + (i === this.paletteSel ? ' sel' : ''))
      row.append(txt('span', 'hv-pal-name', c.label), txt('span', 'hv-pal-hintc', c.hint))
      // Клик/тап по строке = Enter (и на desktop: листинг — мышевый UX тоже)
      row.addEventListener('click', () => {
        this.paletteSel = i
        this.paletteRun()
      })
      pal.list.append(row)
    })
    pal.list.append(txt('div', 'hv-pal-more', IS_TOUCH ? 'ТАП ПО СТРОКЕ — CP' : '↑↓ ВЫБОР · ENTER → CP · ESC ЗАКРЫТЬ'))
  }

  private updatePalette(): void {
    const pal = this.palette
    if (pal === null) return
    if (pal.input === null) {
      // Дерево на тапе (§15.7/§16.2): устройства → программы | ДАННЫЕ →
      // items (CP/RM) → приёмник cp.
      pal.list.replaceChildren()
      if (this.paletteDataItem !== null) {
        this.paletteTreeDst(pal)
        return
      }
      if (this.paletteDataHost !== null) {
        this.paletteTreeItems(pal, this.paletteDataHost)
        return
      }
      if (this.paletteDev === null) this.paletteTreeDevs(pal)
      else this.paletteTreeProgs(pal, this.paletteDev)
      return
    }
    // ls-листинг (§16.2): ручной ввод уже сбросил paletteLs (input-событие)
    if (this.paletteLs !== null) {
      this.paletteLsRender(pal)
      return
    }
    const tokens = pal.input.value.trim().split(/\s+/).filter((t) => t !== '')
    const trailing = /\s$/.test(pal.input.value)
    const dq = (tokens[0] ?? '').toLowerCase()
    const pq = (tokens[1] ?? '').toLowerCase()
    // Дописываемый токен: хвостовой пробел = следующий токен, иначе текущий
    // (обобщение «cam1␣» из §13.3 на грамматику data из 4 токенов).
    this.paletteTok = trailing ? tokens.length : Math.max(tokens.length - 1, 0)
    const cands: PalCand[] = []
    // Режим «таб» (T): только устройства, второго токена нет (§12.6).
    const isTabMode = this.paletteMode === 'tab'
    // Обратный порядок токенов (плейтест M4): первый токен совпадает с
    // программой (теперь и data, §16.2) и НЕ совпадает ни с устройством.
    const progFirst =
      !isTabMode &&
      dq !== '' &&
      (PALETTE_PROGS.some((p) => p.startsWith(dq)) || DATA_CMD.startsWith(dq)) &&
      ![...this.devices.values()].some((d) => this.devMatch(d, dq))
    // Подкоманда данных первым токеном («/cp», «/decrypt» на объекте):
    // кандидаты — ключи активного хоста; вставка переписывает строку в
    // каноническую reverse-форму `<key> cp` (палитра не находила
    // кандидатов, хотя ключи в деке есть — плейтест M5).
    const subFirst =
      !isTabMode && dq !== '' && !progFirst &&
      (DATA_SUBS as readonly string[]).some((s) => s.startsWith(dq)) &&
      !PALETTE_PROGS.some((p) => p === dq) &&
      ![...this.devices.values()].some((d) => this.devMatch(d, dq))
    // reverse-форма (§16.2): первый токен — item активного таба
    // («door_key cp t2» из открытого таба с данными).
    const activeHost = this.dataCtxHost()
    const revItems = isTabMode
      ? []
      : this.dataHostItems(activeHost).filter((it) => dq === '' || it.n.toLowerCase().startsWith(dq))
    const revMode =
      !isTabMode && dq !== '' && !progFirst && revItems.length > 0 &&
      ![...this.devices.values()].some((d) => this.devMatch(d, dq))
    // Команда данных: 'data …' или '[host] data …' (обратный порядок).
    const hostPrefix = pq === DATA_CMD && dq !== DATA_CMD ? this.dataHostAt(dq) : null
    const dataMode = !isTabMode && (dq === DATA_CMD || (pq === DATA_CMD && hostPrefix !== null))
    if (isTabMode || (!progFirst && !dataMode && !revMode && !subFirst && this.paletteTok === 0)) {
      // Первый токен (порядок «dev prog» / режим таба): устройства, потом
      // программы + DATA, в хвосте — items активного таба (reverse §16.2).
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
          // §15.28: «УЖЕ В ТАБАХ» — статус таба, не владение → owner undefined
          owner: isTabMode && this.tabs.some((t) => t.dev === d.id) ? undefined : d.owner,
        })
      }
      if (!isTabMode) {
        for (const p of PALETTE_PROGS) {
          if (p.startsWith(dq)) cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint: 'ПРОГРАММА' })
        }
        if (dq === '' || DATA_CMD.startsWith(dq)) {
          cands.push({ kind: 'datacmd', text: DATA_CMD, label: 'DATA', hint: 'ДАННЫЕ LS/CP/MV/RM/🔓' })
        }
        if (dq === '' || 'decrypt'.startsWith(dq)) {
          cands.push({ kind: 'decryptcmd', text: 'decrypt', label: 'DECRYPT', hint: 'КЛЮЧ — NPU-ДЖОБА' })
        }
        for (const it of revItems) {
          cands.push({
            kind: 'item',
            text: this.itemText(it.n, activeHost),
            dev: activeHost,
            data: it.n,
            label: `${it.n.toUpperCase()} ${it.mb}МБ${it.enc ? ' 🔒' : ''}`,
            hint: activeHost === 'deck' ? '@ДЕКА' : `@${activeHost.toUpperCase()}`,
          })
        }
      }
    } else if (progFirst && this.paletteTok === 0) {
      // Первый токен (порядок «prog dev»): программы + DATA; Enter уже сейчас
      // выполнит на текущей цели — говорим об этом в подсказке.
      for (const p of PALETTE_PROGS) {
        if (!p.startsWith(dq)) continue
        const hint =
          this.target !== null ? `ENTER → ${this.target.toUpperCase()}` : p === 'portscan' ? 'ENTER — ВСЯ СЕТЬ' : 'ENTER — ЦЕЛЬ НЕ ВЫБРАНА'
        cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint })
      }
      if (DATA_CMD.startsWith(dq)) {
        cands.push({ kind: 'datacmd', text: DATA_CMD, label: 'DATA', hint: 'ENTER — ЛИСТИНГ ТАБА' })
      }
      if ('decrypt'.startsWith(dq)) {
        cands.push({ kind: 'decryptcmd', text: 'decrypt', label: 'DECRYPT', hint: 'КЛЮЧ — NPU-ДЖОБА' })
      }
    } else if (dataMode) {
      // Аргументы data (§16.2): [host] sub key [dst]. Последний токен 'data'
      // без хвостового пробела — уже завершённая команда, а не запрос.
      const start = dq === DATA_CMD ? 1 : 2
      const prev = tokens.slice(start, tokens.length - (trailing ? 0 : 1)).map((t) => t.toLowerCase())
      const q0 = trailing ? '' : (tokens[tokens.length - 1] ?? '').toLowerCase()
      const q = q0 === DATA_CMD ? '' : q0
      cands.push(...this.dataCands(prev, q, hostPrefix))
    } else if (revMode) {
      // reverse: item выбран → подкоманда → приёмник
      if (this.paletteTok === 0) {
        for (const it of revItems) {
          cands.push({
            kind: 'item',
            text: this.itemText(it.n, activeHost),
            dev: activeHost,
            data: it.n,
            label: `${it.n.toUpperCase()} ${it.mb}МБ${it.enc ? ' 🔒' : ''}`,
            hint: activeHost === 'deck' ? '@ДЕКА' : `@${activeHost.toUpperCase()}`,
          })
        }
      } else if (this.paletteTok === 1) {
        cands.push(...this.dataSubCands(pq, ['cp', 'mv', 'rm', 'decrypt']))
      } else {
        // decrypt — одноаргументная: приёмника нет, ключ уже дан
        const qq = (tokens[2] ?? '').toLowerCase()
        const src = this.dataSrcOf(dq, null)
        if (tokens[1]?.toLowerCase() !== 'decrypt') {
          cands.push(...this.dataHostCands(qq, true).filter((c) => c.dev !== src))
        }
      }
    } else if (subFirst) {
      // «/cp⏎» на объекте: ключи активного хоста; выбор перепишет строку в
      // каноническую reverse-форму `<key> cp` (см. paletteRun).
      // Фильтр — по КЛЮЧУ (второй токен), не по подкоманде: «rm» сам по себе
      // не префикс имён, и список был пуст (плейтест M5 «почему для rm нет
      // кандидатов»).
      const qk = tokens.length < 2 ? '' : trailing ? '' : (tokens[tokens.length - 1] ?? '').toLowerCase()
      for (const it of this.dataHostItems(activeHost)) {
        const text = this.itemText(it.n, activeHost)
        if (qk !== '' && !text.toLowerCase().startsWith(qk) && !it.n.toLowerCase().startsWith(qk)) continue
        cands.push({
          kind: 'item',
          text,
          dev: activeHost,
          data: it.n,
          label: `${it.n.toUpperCase()} ${it.mb}МБ${it.enc ? ' 🔒' : ''}`,
          hint: `${dq.toUpperCase()} · ${activeHost === 'deck' ? 'ДЕКА' : activeHost.toUpperCase()}`,
        })
      }
    } else if (progFirst) {
      // Второй токен (порядок «prog dev»): список целей с владельцем.
      const devs = [...this.devices.values()]
        .filter((d) => this.devMatch(d, pq))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
      for (const d of devs) {
        cands.push({
          kind: 'dev',
          text: d.id,
          dev: d.id,
          label: `${d.id.toUpperCase()} ${KIND_LABEL[d.kind]}`,
          hint: this.ownerLabel(d.owner),
          owner: d.owner, // §15.28
        })
      }
    } else {
      // Второй токен (порядок «dev prog»): ВСЕ программы для выбранного
      // устройства (+ DATA = листинг его данных), с подсказкой готовности.
      const dev = [...this.devices.values()].find((d) => this.devMatch(d, dq))
      for (const p of PALETTE_PROGS) {
        if (!p.startsWith(pq)) continue
        let hint = 'ГОТОВО'
        if (p === 'portscan') hint = 'БЕЗ ЦЕЛИ'
        else if (p === 'trojan' && dev !== undefined && !dev.vulned) hint = 'СНАЧАЛА VULNSCAN'
        cands.push({ kind: 'prog', text: p, prog: p, label: PROG_LABEL[p], hint })
      }
      if (pq === '' || DATA_CMD.startsWith(pq)) {
        const n = dev !== undefined ? this.dataHostItems(dev.id).length : this.deckData.length
        cands.push({ kind: 'datacmd', text: DATA_CMD, dev: dev?.id, label: 'DATA', hint: n > 0 ? `ДАННЫЕ (${n})` : 'ДАННЫЕ LS/CP/MV/RM/🔓' })
      }
    }
    this.paletteCands = cands
    if (this.paletteSel >= cands.length) this.paletteSel = cands.length - 1
    pal.list.replaceChildren()
    const MAX_SHOWN = 8
    cands.slice(0, MAX_SHOWN).forEach((c, i) => {
      const row = el('div', 'hv-pal-cand' + (i === this.paletteSel ? ' sel' : ''))
      row.append(txt('span', 'hv-pal-name', c.label))
      const hintEl = txt('span', 'hv-pal-hintc', c.hint)
      if (c.owner !== undefined) hintEl.classList.add(this.palOwnerCls(c.owner)) // §15.28
      row.append(hintEl)
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
      pal.list.append(
        txt(
          'div',
          'hv-dim',
          dataMode ? 'ДАННЫХ НЕТ / НУЖЕН TROJAN — DATA LS' : 'НЕТ КАНДИДАТОВ — PORTSCAN [1] РАСКРОЕТ СЕТЬ',
        ),
      )
    } else if (cands.length > MAX_SHOWN) {
      pal.list.append(txt('div', 'hv-pal-more', `+${cands.length - MAX_SHOWN} …`))
    }
  }

  /** Tab/↑↓: цикл по кандидатам; первый выбор дописывает токен в строку.
   *  В ls-листинге (§16.2) двигаем только выделение — строку не трогаем. */
  /** Стрелки: двигаем ТОЛЬКО подсветку по списку кандидатов (строку ввода
   *  не трогаем — в отличие от Tab-цикла, плейтест M5 «вниз сразу выбирает
   *  первый объект»). Enter по подсвеченному — paletteRun. */
  private paletteMove(dir: 1 | -1): void {
    if (this.palette === null || this.palette.input === null || this.paletteCands.length === 0) return
    const len = this.paletteCands.length
    this.paletteSel = this.paletteSel < 0 ? (dir > 0 ? 0 : len - 1) : (this.paletteSel + dir + len) % len
    this.updatePalette()
  }

  private paletteCycle(dir: 1 | -1): void {
    const pal = this.palette
    if (pal === null || pal.input === null || this.paletteCands.length === 0) return
    const len = this.paletteCands.length
    this.paletteSel = this.paletteSel < 0 ? 0 : (this.paletteSel + dir + len) % len
    const c = this.paletteCands[this.paletteSel]
    if (this.paletteMode === 'tab') {
      pal.input.value = c.text // без хвостового пробела: второго токена нет
    } else if (this.paletteLs !== null) {
      // ls: строка остаётся «data <host> ls», Esc/Enter работают как раньше
      this.updatePalette()
      return
    } else {
      // Дополняемый токен paletteTok заменяем кандидатом (+ пробел — следующий
      // Tab дополнит следующий токен); грамматика data — та же схема (§16.2).
      const tokens = pal.input.value.trim().split(/\s+/).filter((t) => t !== '')
      const parts = tokens.slice(0, Math.min(this.paletteTok, tokens.length))
      parts.push(c.text)
      pal.input.value = `${parts.join(' ')} `
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
    if (pal === null || pal.input === null || this.paletteMode === 'tab' || this.cmdHistory.length === 0) return
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
   *  открыть таб на устройство (§12.6). Команда данных `data` (§16.2) и
   *  reverse-форма item-первым-токеном перехватываются до программ. */
  private paletteRun(): void {
    const pal = this.palette
    if (pal === null || pal.input === null) return // на тапе — дерево (§15.7)
    // ls-листинг (§16.2): Enter на строке — заготовка cp, пустой выбор — ничего
    if (this.paletteLs !== null) {
      const selLs =
        this.paletteSel >= 0 && this.paletteSel < this.paletteCands.length
          ? this.paletteCands[this.paletteSel]
          : undefined
      if (selLs !== undefined && selLs.kind === 'item' && selLs.data !== undefined) {
        const host = this.paletteLs
        this.paletteLs = null
        pal.input.value = host === 'deck' ? `data cp ${selLs.data} ` : `data ${host} cp ${selLs.data} `
        this.paletteSel = -1
        this.updatePalette()
      }
      return
    }
    const raw = pal.input.value.trim()
    const tokens = raw.split(/\s+/).filter((t) => t !== '')
    let sel =
      this.paletteSel >= 0 && this.paletteSel < this.paletteCands.length
        ? this.paletteCands[this.paletteSel]
        : undefined
    // Единственный кандидат — Enter его и вставляет (плейтест M5): без этого
    // при одном варианте Enter запускал сырой ввод и терял токен.
    if (sel === undefined && this.paletteCands.length === 1) sel = this.paletteCands[0]
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
    const t0 = (tokens[0] ?? '').toLowerCase()
    const t1 = (tokens[1] ?? '').toLowerCase()
    // Enter по подсвеченному кандидату — ВСТАВИТЬ токен в строку (как Tab),
    // не запускать (плейтест M5: «Enter на ключе — а оно сразу „укажи
    // приёмник“»; вторая реплика: «нажал Enter на 06_19 — не подставилось» —
    // хвостовой пробел в строке ошибочно считался «дописывать нечего»).
    // Вставка работает и с пробелом: ключ — это СЛЕДУЮЩИЙ токен.
    if (sel !== undefined && ['dev', 'item', 'sub', 'datacmd'].includes(sel.kind)) {
      // Подкоманда первым токеном («/cp» + ключ): канонизируем в reverse-
      // форму `<key> cp ` — дальше штатный разбор reverse-формы.
      const t0s = (tokens[0] ?? '').toLowerCase()
      const subFirstMode =
        sel.kind === 'item' &&
        (DATA_SUBS as readonly string[]).includes(t0s) &&
        !PALETTE_PROGS.some((p) => p === t0s) &&
        ![...this.devices.values()].some((d) => this.devMatch(d, t0s))
      if (subFirstMode) {
        pal.input.value = `${sel.text} ${t0s} `
        this.paletteSel = -1
        this.updatePalette()
        return
      }
      const parts = tokens.slice(0, Math.min(this.paletteTok, tokens.length))
      parts.push(sel.text)
      pal.input.value = `${parts.join(' ')} `
      this.paletteSel = -1
      this.updatePalette()
      return
    }
    const finalTokens = tokens
    // Команда данных (§16.2): 'data …' / '[host] data …'
    if (t0 === DATA_CMD) {
      this.runDataCmd(finalTokens.slice(1), null)
      return
    }
    // §16.4: 'decrypt <key>[@host]' — джоба на хосте, где лежат данные
    // (контекст-подсказка как у data: key@host или [key host]).
    if (t0 === 'decrypt') {
      const keyTok = (finalTokens[1] ?? '').toLowerCase()
      if (keyTok === '') {
        this.toast('УКАЖИ КЛЮЧ — DATA LS ПОКАЖЕТ СПИСОК')
        return
      }
      const at = keyTok.indexOf('@')
      const name = at >= 0 ? keyTok.slice(0, at) : keyTok
      const hint =
        at >= 0
          ? this.dataHostAt(keyTok.slice(at + 1))
          : finalTokens[2] !== undefined
            ? this.dataHostAt(finalTokens[2].toLowerCase())
            : null
      const src = this.resolveDataSrc(name, hint)
      if (src !== null) {
        this.sendDecrypt(src.host, src.key)
        this.pushHistoryClose(raw)
      }
      return
    }
    if (sel !== undefined && sel.kind === 'decryptcmd') {
      pal.input.value = 'decrypt '
      this.paletteSel = -1
      this.updatePalette()
      return
    }
    if (t1 === DATA_CMD) {
      const host = this.dataHostAt(t0)
      if (host !== null) {
        this.runDataCmd(finalTokens.slice(2), host)
        return
      }
    }
    // reverse-форма (§16.2/§16.4): item активного таба + cp/rm/decrypt.
    // Гвард — точное имя item, иначе «cam1 cp» даст тост про данные до тоста
    // про программу.
    // reverse-форма (§16.2/§16.4): item активного таба + cp/rm/decrypt.
    // Ключ может быть с суффиксом @host (однозначный выбор дубликата).
    const revKeyTok = (finalTokens[0] ?? '').toLowerCase()
    const revAt = revKeyTok.indexOf('@')
    const revName = revAt >= 0 ? revKeyTok.slice(0, revAt) : revKeyTok
    const revHost = revAt >= 0 ? this.dataHostAt(revKeyTok.slice(revAt + 1)) : null
    if ((t1 === 'cp' || t1 === 'mv' || t1 === 'rm' || t1 === 'decrypt') && this.dataHostItems(this.dataCtxHost()).some((it) => it.n === revName)) {
      const src = this.resolveDataSrc(revName, revHost)
      if (src !== null) {
        if (t1 === 'rm' || t1 === 'decrypt') {
          this.sendData(t1, src.host, src.key, null)
          this.pushHistoryClose(raw)
          return
        }
        let dst = 'deck'
        if (finalTokens.length > 2) {
          const dh = this.dataHostAt((finalTokens[2] ?? '').toLowerCase())
          if (dh === null) {
            this.toast('НЕТ ТАКОГО ПРИЁМНИКА — TAB ПОКАЖЕТ СПИСОК')
            return
          }
          dst = dh
        }
        if (dst === src.host) {
          this.toast('ИСТОЧНИК = ПРИЁМНИК')
          return
        }
        this.sendData(t1 as 'cp' | 'mv', src.host, src.key, dst)
        this.pushHistoryClose(raw)
        return
      }
    }
    // Кандидат-item первого токена (reverse без подкоманды) — дописываем и
    // ждём cp/rm; кандидат-datacmd — листинг цели.
    if (sel !== undefined && sel.kind === 'item' && this.paletteTok === 0) {
      pal.input.value = `${sel.text} `
      this.paletteSel = -1
      this.updatePalette()
      return
    }
    if (sel === undefined && tokens.length === 1 && !/\s$/.test(pal.input.value)) {
      // «/door⏎» без выбора — единственный вхождение-префикс item таба
      const host = this.dataCtxHost()
      const hit = this.dataHostItems(host).find((it) => it.n.toLowerCase().startsWith(t0))
      if (
        hit !== undefined &&
        t0 !== '' &&
        ![...this.devices.values()].some((d) => this.devMatch(d, t0))
      ) {
        pal.input.value = `${hit.n} `
        this.paletteSel = -1
        this.updatePalette()
        return
      }
    }
    if (sel !== undefined && sel.kind === 'datacmd') {
      this.execDataLs(sel.dev ?? this.dataCtxHost(), raw)
      return
    }
    // Порядок токенов — тот же детектор, что в updatePalette: первый токен,
    // совпадающий с программой и не с устройством, — это «prog dev».
    const progFirst =
      t0 !== '' &&
      (PALETTE_PROGS.some((p) => p.startsWith(t0)) || DATA_CMD.startsWith(t0)) &&
      ![...this.devices.values()].some((d) => this.devMatch(d, t0))
    // Цель: выделенный кандидат-устройство; иначе — токен цели своего
    // порядка (второй в «prog dev», первый в «dev prog»).
    let dev: string | null = null
    if (sel !== undefined && sel.kind === 'dev' && sel.dev !== undefined) {
      dev = sel.dev
    } else if (tokens.length > 0) {
      const dq = progFirst ? (tokens[1] ?? '').toLowerCase() : t0
      if (dq !== '') {
        const m = [...this.devices.values()].filter((d) => this.devMatch(d, dq))
        dev = m.length === 1 ? m[0].id : (m.find((d) => d.id === dq)?.id ?? null)
      }
    }
    // Программа: выделенный кандидат-программа, иначе фильтр по токену
    // программы своего порядка (первый в «prog dev»).
    let pq = progFirst ? t0 : (tokens[1] ?? (tokens[0] ?? ''))
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
        this.toast(`ЦЕЛЬ: ${dev.toUpperCase()} — ${IS_TOUCH ? 'КНОПКИ 1–6 / 7 DATA' : 'ХОТКЕИ 1–6 / 7 DATA'}`)
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
    // Ник вместо «ИГРОК #171» (плейтест M4: в чужом узле надо видеть, ЧЕЙ он).
    const name = this.deps.nameOf(owner)
    return (name !== null ? name : `player_${owner}`).toUpperCase()
  }

  /** Окрашенный спан владельца: чужая команда — красным (ownerColor). */
  private ownerSpan(owner: number | null): HTMLElement {
    const s = txt('span', 'owner-name', this.ownerLabel(owner))
    s.style.color = this.ownerColor(owner)
    return s
  }

  private ownerColor(owner: number | null): string {
    if (owner === null) return '#7d8f85' // нейтральный серый
    if (owner === this.myId) return '#ffffff'
    return this.deps.teamOf(owner) === this.deps.teamOf(this.myId ?? -1) ? '#ffffff' : '#ff4d5e'
  }

  /** §15.28 (ревебр owner): владение в палитре — цветом подписи-хеша:
   *  зелёный «ВЫ»/союзник, жёлтый нейтрально, красный враг. Три bucket'а —
   *  в палитре надо за тап/глаз понять «можно ли трогать», детали чьё-то
   *  имя несут текстом. */
  private palOwnerCls(owner: number | null): string {
    if (owner === null) return 'pal-neut'
    if (owner === this.myId) return 'pal-you'
    return this.deps.teamOf(owner) === this.deps.teamOf(this.myId ?? -1) ? 'pal-you' : 'pal-enemy'
  }

  /** Firewall чей (§13.5): свой / союзный / чужой — подпись бейджа. */
  private fwLabel(by: number): string {
    if (by === this.myId) return 'СВОЙ'
    const myTeam = this.myId !== null ? this.deps.teamOf(this.myId) : null
    return myTeam !== null && this.deps.teamOf(by) === myTeam ? 'СОЮЗНИК' : `ВРАГ ${this.deps.nameOf(by) ?? `player_${by}`.toUpperCase()}`
  }

  /** Цвет бейджа/ореола firewall (§13.5): свой/союзный голубой, чужой красный. */
  private fwColor(by: number): string {
    if (by === this.myId) return '#5fd7ff'
    const myTeam = this.myId !== null ? this.deps.teamOf(this.myId) : null
    return myTeam !== null && this.deps.teamOf(by) === myTeam ? '#5fd7ff' : '#ff4d5e'
  }

  private render(): void {
    if (!this._active) return
    // render() перестраивает DOM целиком — фокус с клавиатуры (линки ходятся
    // табом/стрелками, плейтест M4) восстанавливаем по data-link чипу.
    const refocusLink =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.link : undefined
    // §15.26: structural render во время пана/пинча карты откладывается до
    // конца жеста — карта под пальцем не пересобирается (скан, табы, цели).
    if ((this.netmapPointers.size > 0 || this.pinchDist > 0) && !this.netmapRenderHeld) {
      this.netmapRenderHeld = true
      return
    }
    this.sparkRefs = []
    this.progLists = []
    this.netmapBoxes = []
    this.netmapHi.clear()
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
        // §15.17 (тап): повторный тап по АКТИВНОМУ табу устройства открывает
        // палитру действий, уже сидящую на этом устройстве, — на тапе из
        // открытого таба нечем было запустить софт (десктоп для этого жмёт
        // «/<dev> <prog>», tree-палитра §15.7 требовала тыкать дерево заново).
        const isActive = this.panes[this.activePane].tabKey === tab.key
        if (IS_TOUCH && isActive && tab.dev !== null && tab.dev !== undefined) {
          this.openPalette('run', tab.dev)
          return
        }
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
      ? 'ЧИБЫ — ТАБЫ · [ / ] ПАЛИТРА · ВЫХОД — КНОПКА СПРАВА'
      : 'T ТАБ [ФИЛЬТР] · W ЗАКРЫТЬ · H/V СПЛИТ · F1..F9 ПЕРЕКЛЮЧИТЬ · 1–6 ПРОГРАММЫ · / ПАЛИТРА · CTRL+ALT+DEL ДЖЕК-АУТ'
    main.append(foot)

    if (this.menuOpen) main.append(this.buildMenu())

    this.updateDeckData()
    this.updateDoorStates()
    this.updateNetmaps()
    this.updateCamFeeds()
    this.updateRadar()
    if (refocusLink !== undefined) {
      main.querySelector<HTMLElement>(`[data-link="${refocusLink}"]`)?.focus()
    }
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
    // Графики — одной горизонтальной строкой НАД контентом (плейтест M3:
    // в узкой левой колонке канвасы наезжали на карту сети).
    const sparks = el('div', 'hv-sparks')
    sparks.append(this.buildSpark('cpu', 'CPU'))
    sparks.append(this.buildSpark('npu', 'NPU'))
    sparks.append(this.buildSpark('ram', 'RAM'))
    sparks.append(this.buildSpark('net', 'NET'))

    // Список процессов (общий для колоночной и доковой версий).
    const progsBox = el('div', 'hv-progs')
    this.progLists.push(progsBox)

    // §16.1: MEM деки — занято/ёмкость + инвентарь данных (живой список)
    const memBox = el('div', 'hv-progs')
    memBox.append(txt('div', 'hv-dim deck-memlabel', 'MEM ДЕКИ'))
    const memLine = txt('div', 'prog-name', '0/0 МБ')
    memBox.append(memLine)
    const inv = el('div', 'hv-progs')
    memBox.append(inv)
    this.deckDataBox = inv
    this.deckMemLine = memLine

    const run = el('div', 'hv-run')
    // §15.27: на тапе цифры-хоткеи бессмысленны (клавиатуры нет), суффикс
    // «→ ЦЕЛЬ?» съедает ширину плитки — на кнопках чистое имя программы.
    const PROGS: readonly (readonly [string, RunProg])[] = IS_TOUCH
      ? [
          ['PORTSCAN', 'portscan'],
          ['VULNSCAN', 'vulnscan'],
          ['TROJAN', 'trojan'],
          ['WATCHER', 'watcher'],
          ['FIREWALL', 'firewall'],
          ['ANTIVIRUS', 'antivirus'],
        ]
      : [
          ['1 PORTSCAN', 'portscan'],
          ['2 VULNSCAN', 'vulnscan'],
          ['3 TROJAN', 'trojan'],
          ['4 WATCHER', 'watcher'],
          ['5 FIREWALL', 'firewall'],
          ['6 ANTIVIRUS', 'antivirus'],
        ]
    for (const [label, prog] of PROGS) {
      const b = el('button', 'hv-btn')
      b.textContent = label + this.targetSuffix()
      b.addEventListener('click', () => this.runProg(prog))
      run.append(b)
    }
    // §16.2: одна кнопка данных — палитра с листингом активного таба
    const dataBtn = el('button', 'hv-btn')
    dataBtn.textContent = IS_TOUCH ? 'ДАННЫЕ' : '7 DATA'
    dataBtn.addEventListener('click', () => this.dataEntry())
    run.append(dataBtn)
    // [ / ] — тап-эквивалент клавиши '/' (ГДД §15.2): на мобильнике хоткея нет.
    const slash = el('button', 'hv-btn hv-btn-slash')
    slash.textContent = IS_TOUCH ? 'ПАЛИТРА' : '/ ПАЛИТРА'
    slash.addEventListener('click', () => this.openPalette('run'))
    run.append(slash)

    const right = el('div', 'deck-right')
    const netmapBox = el('div', 'hv-netmap')
    this.netmapBoxes.push(netmapBox)
    right.append(netmapBox)
    // §15.26: на тапе подсказка называет все три жеста — пан и щипок раньше
    // были невидимы для пользователя, «карту смотреть невозможно».
    // §15.27: короче — в портретном доке обязана влезать в одну строку.
    right.append(
      txt(
        'div',
        'netmap-hint',
        IS_TOUCH ? 'ПАН · ЩИПОК — ЗУМ · ТАП ПО УЗЛУ — ЦЕЛЬ' : 'КЛИК ПО УЗЛУ — ВЫБОР ЦЕЛИ СКАНА',
      ),
    )

    if (IS_TOUCH) {
      // §15.27 (ревебр owner: «layout под мобилой практически неюзабельный,
      // кнопки слишком узкие по высоте»): док снизу вместо колонок. Карта —
      // главный блок на всю ширину; под ней строка статуса (MEM+процессы) и
      // грид кнопок-плиток 44px. В ландшафте ≥600px CSS-grid ставит статус
      // в одну строку со спарками (правый угол), освобождая карте строку.
      const status = el('div', 'deck-status')
      status.append(memBox, progsBox)
      const wrap = el('div', 'deck-wrap')
      wrap.append(sparks, right, status, run)
      body.append(wrap)
      return
    }

    const cols = el('div', 'deck-cols')
    const wrap = el('div', 'deck-wrap')
    wrap.append(sparks, cols)
    body.append(wrap)
    const left = el('div', 'deck-left')
    left.append(progsBox, memBox, run)
    cols.append(left, right)
  }

  private targetSuffix(): string {
    // §15.27: на тапе — короткий бейдж цели (ширина плитки), без «ЦЕЛЬ?».
    if (IS_TOUCH) return this.target !== null ? `·${this.target.toUpperCase()}` : ''
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
    // Газ (M4 §14.2) и водяной клапан (§14.6.1) — те же управляемые устройства,
    // что дверь: общий UX-панель (статус + TOGGLE + подсказка про trojan),
    // подпись статуса выбирается в updateDoorStates по kind.
    if (d.kind === 'door' || d.kind === 'gas' || d.kind === 'valve') {
      const wrap = el('div', 'door-ui')
      const status = el('div', 'door-status')
      wrap.append(status)
      const doorOwn = el('div', 'door-owner')
      doorOwn.append('ВЛАДЕЛЕЦ: ', this.ownerSpan(d.owner))
      wrap.append(doorOwn)
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
      const camOwn = el('div', 'cam-owner')
      camOwn.append('ВЛАДЕЛЕЦ: ', this.ownerSpan(d.owner), ' · РАДИУС 12 М + LOS')
      wrap.append(camOwn)
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
    // ШИНА (M5 §16.3, итерация 1.5 — плейтест: bw должен быть виден в табах):
    // backplane свитча — суммарная шина транзита, её делят все трансферы.
    if (d.bp !== undefined) row('ШИНА', `${Math.round(d.bp)} МБ/С`)
    // MEM (M5 §16.1): ёмкость и свободно (резервации cp учтены сервером).
    if (d.mem !== undefined) {
      // MEM (M5 §16.1): занято/ёмкость — как в шапке ls и на деке (плейтест:
      // «4/64» в формате свободно/всего читалось как «почти пусто», хотя
      // door_key 60 МБ уже лежал там)
      row('MEM', `${d.mem - (d.memFree ?? 0)}/${d.mem} МБ`)
    }
    // Данные (§16.9): листинг — только владельцу (сервер не шлёт чужим);
    // рядом кнопки RSYNC → ДЕКА и RM (chaff-игра §16.2).
    if (d.data !== undefined && d.data.length > 0) {
      const dr = el('div', 'dev-row')
      dr.append(txt('span', 'dev-k', 'ДАННЫЕ'))
      const dv = el('span', 'dev-v')
      for (const it of d.data) {
        const line = el('div', 'dev-data-row')
        line.append(txt('span', 'dev-data-name', `${it.n} ${it.mb}МБ${it.enc ? ' 🔒' : ''}${it.code !== undefined ? ` код ${it.code}` : ''}`))
        if (it.enc) {
          // §16.4: decrypt на хосте (SRV NPU ×3 — 6 МБ/с; без NPU сервер
          // ответит denied npu «НУЖЕН NPU»)
          const dc = el('button', 'dev-link')
          dc.textContent = '🔓'
          dc.title = `decrypt ${it.n} на хосте (NPU)`
          dc.addEventListener('click', (e) => {
            e.stopPropagation()
            this.sendDecrypt(d.id, it.n)
          })
          line.append(dc)
        }
        const rs = el('button', 'dev-link')
        rs.textContent = '→ ДЕКА'
        rs.addEventListener('click', (e) => {
          e.stopPropagation()
          this.sendData('cp', d.id, it.n, 'deck')
        })
        line.append(rs)
        const rm = el('button', 'dev-link')
        rm.textContent = '🗑 RM'
        rm.addEventListener('click', (e) => {
          e.stopPropagation()
          this.sendData('rm', d.id, it.n, null)
        })
        line.append(rm)
        dv.append(line)
      }
      dr.append(dv)
      info.append(dr)
    }
    // Владелец узла, открытого по связи из SWITCH и т.п.: ник + цвет команды.
    const ownRow = el('div', 'dev-row')
    const ownVal = this.ownerSpan(d.owner)
    ownVal.classList.add('dev-v') // сетка строки как у остальных dev-row
    ownRow.append(txt('span', 'dev-k', 'ВЛАДЕЛЕЦ'), ownVal)
    info.append(ownRow)
    // СВЯЗИ — кликабельные чипы (тап и клик, desktop тоже, ГДД §15.7):
    // тап по связи открывает таб устройства. Не-просканированные ссылки
    // остаются тусклым текстом — открыть нечего.
    {
      const r = el('div', 'dev-row')
      r.append(txt('span', 'dev-k', 'СВЯЗИ'))
      const v = el('span', 'dev-v dev-links')
      if (d.links.length === 0) v.append(txt('span', 'dev-links-none', '—'))
      for (const l of d.links) {
        if (!this.devices.has(l)) {
          v.append(txt('span', 'dev-links-none', l.toUpperCase()))
          continue
        }
        const chip = el('button', 'dev-link')
        const mbps = d.net?.find((n) => n.id === l)?.mbps
        chip.textContent = mbps !== undefined ? `${l.toUpperCase()} · ${Math.round(mbps)}` : l.toUpperCase()
        chip.title = mbps !== undefined ? `Канал ${Math.round(mbps)} МБ/с` : ''
        chip.dataset.link = l // для восстановления фокуса после render()
        chip.addEventListener('click', (e) => {
          e.stopPropagation()
          this.ensureTab(l, true)
          this.toast(`ТАБ: ${l.toUpperCase()}`)
          this.schedule(() => this.render())
        })
        v.append(chip)
      }
      // Клавиатура по линкам (плейтест M4): Tab фокусирует чип (нативно),
      // стрелки ходят между чипами, Enter/Space открывают (нативный клик по
      // button — Space до сюда доходит, т.к. onFocusButton в onKeyDown).
      v.addEventListener('keydown', (e) => {
        const chips = [...v.querySelectorAll<HTMLButtonElement>('button.dev-link')]
        const i = chips.indexOf(document.activeElement as HTMLButtonElement)
        if (i === -1) return
        const step =
          e.key === 'ArrowRight' || e.key === 'ArrowDown'
            ? 1
            : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
              ? -1
              : e.key === 'Home'
                ? -i
                : e.key === 'End'
                  ? chips.length - 1 - i
                  : 0
        if (step === 0) return
        e.preventDefault()
        chips[(i + step + chips.length) % chips.length]?.focus()
      })
      r.append(v)
      info.append(r)
    }
    info.append(txt('div', 'hv-dim', 'КОНТРОЛЛЕРОВ НЕТ — ЗАГЛУШКА M2'))
    body.append(info)
    this.appendWatchPanel(body, dev, d)
  }

  /** Панель «ПРОЦЕССЫ» (§13.1, ред. 2026-11-17 — бывш. «РАДАР СЕГМЕНТА»):
   *  секция «СОФТ» (что на устройстве запущено и кем — только владельцу,
   *  §9.2 soft), «СЕТЬ» (радар-срез 1 Гц, сервер шлёт только живому хозяину
   *  watcher'а) и журнал событий. На watched-устройстве добавляется к любому
   *  контенту таба — устройство остаётся устройством (дверь управляется,
   *  лента камеры идёт). */
  private appendWatchPanel(body: HTMLElement, dev: string, d: ScanDevice): void {
    if (d.watched !== true) return
    const wrap = el('div', 'watch-ui')
    const watchOwn = el('div', 'watch-owner')
    watchOwn.append('ВЛАДЕЛЕЦ: ', this.ownerSpan(d.owner), ' · WATCHER АКТИВЕН')
    wrap.append(watchOwn)
    const soft = el('div', 'watch-radar')
    const shead = el('div', 'watch-radar-head')
    shead.append(txt('span', 'watch-radar-title', 'СОФТ'))
    const slist = el('div', 'watch-radar-list')
    if (d.soft !== undefined && d.soft.length > 0) {
      for (const s of d.soft) {
        const row = el('div', 'watch-radar-row')
        row.append(txt('span', 'radar-prog', s.p.toUpperCase()))
        const own = txt('span', 'radar-host', this.ownerLabel(s.o))
        own.style.color = this.ownerColor(s.o)
        row.append(own)
        slist.append(row)
      }
    } else {
      slist.append(txt('div', 'hv-dim', 'НЕТ ДАННЫХ (НЕ ВЛАДЕЛЕЦ)'))
    }
    soft.append(shead, slist)
    wrap.append(soft)
    const radar = el('div', 'watch-radar')
    const rhead = el('div', 'watch-radar-head')
    rhead.append(txt('span', 'watch-radar-title', 'СЕТЬ'))
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
    // §16.1: MEM деки + инвентарь (точечно, 2 Гц)
    if (this.deckMemLine !== null) {
      this.deckMemLine.textContent = `${this.deckMemUsed}/${this.deckMemCap} МБ`
    }
    if (this.deckDataBox !== null) {
      this.deckDataBox.replaceChildren()
      if (this.deckData.length === 0) {
        this.deckDataBox.append(txt('div', 'hv-dim', 'ДАННЫХ НЕТ — 7 DATA / ПАЛИТРА'))
      }
      for (const it of this.deckData) {
        const row = el('div', 'hv-prog')
        row.append(txt('span', 'prog-name', `${it.n} ${it.mb}МБ${it.enc ? ' 🔒' : ''}${it.code ? ` код ${it.code}` : ''}`))
        if (it.enc) {
          // §16.4: decrypt на деке (NPU ×1, 2 МБ/с) — джоба в списке процессов
          const dc = el('button', 'dev-link')
          dc.textContent = '🔓'
          dc.title = `decrypt ${it.n} (дека, 2 МБ/с)`
          dc.addEventListener('click', () => {
            this.sendDecrypt('deck', it.n)
          })
          row.append(dc)
        }
        const rm = el('button', 'dev-link')
        rm.textContent = '🗑'
        rm.title = `data deck rm ${it.n}`
        rm.addEventListener('click', () => {
          this.sendData('rm', 'deck', it.n, null)
        })
        row.append(rm)
        this.deckDataBox.append(row)
      }
    }
  }

  private fillProgs(list: HTMLElement): void {
    list.replaceChildren()
    // Пустой список — просто пусто: процесс запущенный виден, а заглушка
    // «ПРОЦЕССОВ НЕТ — КНОПКИ/КЛАВИШИ 1–6» только шумела (ревебр owner §15.8;
    // подсказок достаточно — ряд кнопок, футер, палитра).
    for (const p of this.progs) {
      const row = el('div', 'hv-prog')
      const name = `${PROG_LABEL[p.prog] ?? p.prog}${p.dev !== null ? ` → ${p.dev.toUpperCase()}` : ''}`
      row.append(txt('span', 'prog-name', `#${p.id} ${name}`))
      if ((p.prog === 'cp' || p.prog === 'mv' || p.prog === 'decrypt') && p.data !== undefined) {
        // §16.9: остаток МБ и скорость трансфера (decrypt — NPU-доля)
        row.append(txt('span', 'prog-eta', `${p.data} ${p.mbLeft ?? '?'}МБ · ${p.mbps ?? '?'}МБ/с`))
      } else {
        row.append(txt('span', 'prog-eta', `${(p.etaMs / 1000).toFixed(1)}с`))
      }
      list.append(row)
    }
  }

  private updateDoorStates(): void {
    for (const ref of this.doorRefs) {
      const open = this.valveOpen.get(ref.dev) ?? false
      // газ (M4 §14.2) / вода (§14.6.1): та же панель, свои подписи статуса
      ref.status.textContent =
        ref.kind === 'gas'
          ? `КЛАПАН: ${open ? 'ОТКРЫТ' : 'ЗАКРЫТ'}`
          : ref.kind === 'valve'
            ? `ВОДА: ${open ? 'ИДЁТ' : 'ЗАКРЫТА'}`
            : open
              ? 'ОТКРЫТА'
              : 'ЗАКРЫТА'
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
    name.style.color = s.team === 1 ? '#ff4d5e' : '#ffffff'
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
   *  тоже пишутся); ник, а меты ещё нет — детерминированный player_N. */
  private logWhoName(who: number): string {
    if (who === this.myId) return 'Я'
    return this.deps.nameOf(who) ?? `player_${who}`
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
      name.style.color = this.deps.teamOf(e.who) === 1 ? '#ff4d5e' : '#ffffff'
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
        name.style.color = w.team === 1 ? '#ff4d5e' : '#ffffff'
        row.append(name)
        row.append(txt('span', 'watch-radar-cls', w.cls.toUpperCase()))
        row.append(txt('span', 'watch-radar-host', `ХОСТ ${w.host.toUpperCase()}`))
        ref.list.append(row)
      }
    }
  }

  /** Полный rebuild карт — из render() (скан/табы/цели) и по смене ориентации
   *  (§15.29). Старые hi-записи отсоединённых svg сбрасываем здесь. */
  private updateNetmaps(): void {
    this.netmapHi.clear()
    for (const box of this.netmapBoxes) {
      box.replaceChildren()
      box.append(this.buildNetmapSvg())
    }
  }

  /** Перерисовать содержимое hi-групп без затрагивания svg-каркаса:
   *  viewBox, listeners и pointer capture жестов остаются нетронутыми. */
  private refreshNetmapHi(): void {
    for (const box of this.netmapBoxes) {
      const svg = box.firstElementChild
      if (!(svg instanceof SVGElement)) continue
      const layer = this.netmapHi.get(svg)
      if (layer === undefined || !svg.isConnected) continue
      this.drawNetmapHi(layer.g, layer.pos)
    }
  }

  /** Слой каналов активных операций (плейтест M5): маршрут widest-path из
   *  deck-сообщения 2 Гц поверх обычных связей. Отдельная <g> — чтобы тик
   *  перекладывал только её (§15.26). */
  private drawNetmapHi(gEl: SVGElement, pos: Map<string, { x: number; y: number }>): void {
    gEl.replaceChildren()
    const hiSeen = new Set<string>()
    for (const pr of this.progs) {
      if (pr.path === undefined) continue
      for (let i = 0; i + 1 < pr.path.length; i++) {
        const a = this.devices.get(pr.path[i])
        const b = this.devices.get(pr.path[i + 1])
        if (a === undefined || b === undefined) continue
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
        if (hiSeen.has(key)) continue
        hiSeen.add(key)
        const pa = pos.get(a.id)
        const pb = pos.get(b.id)
        if (pa === undefined || pb === undefined) continue
        const l = svgEl('line')
        l.setAttribute('x1', String(pa.x))
        l.setAttribute('y1', String(pa.y))
        l.setAttribute('x2', String(pb.x))
        l.setAttribute('y2', String(pb.y))
        l.setAttribute('class', 'svg-link svg-link-hi')
        l.style.strokeWidth = String(Math.round(this.netmapBwWidth(this.netmapMbps(a, b)) * 1.7 * 100) / 100)
        gEl.append(l)
      }
    }
  }

  private netmapMbps(a: ScanDevice, b: ScanDevice): number {
    const e = a.net?.find((n) => n.id === b.id) ?? b.net?.find((n) => n.id === a.id)
    return e !== undefined && e.mbps > 0 ? e.mbps : 20
  }

  private netmapBwWidth(mbps: number): number {
    return (1 + mbps / 10) * HackView.NETMAP_S
  }

  /** SVG-карта сети: узлы = discovered устройства, цвет = владелец, клик = цель.
   *  Зум (плейтест M3): колесо мыши и pinch-жест — масштаб к точке курсора,
   *  двойной клик — сброс. Состояние общее для карты деки, живёт до деактивации. */
  private netmapZoom = HackView.NETMAP_ZOOM0
  private netmapCenter: { x: number; y: number } = {
    x: HackView.NETMAP_W / 2,
    y: HackView.NETMAP_H / 2,
  }
  /** §15.29: раскрой карты прошрой сборки (landscape-полосы?) — при смене
   *  ориентации базовые зум/центр сбрасываются, 1.5-зум 780-полосы не live. */
  private netmapLand = false
  private pinchDist = 0
  /** §15.26: hi-слой каждой живой карты (svg → группа + позиции узлов) —
   *  deck-тик обновляет только её, не трогая каркас. */
  private netmapHi = new Map<SVGElement, { g: SVGElement; pos: Map<string, { x: number; y: number }> }>()
  /** §15.26: structural render отложен на время активного пана/пинча. */
  private netmapRenderHeld = false
  // Пан (плейтест M3): активные указатели + порог drag→click.
  private netmapPointers = new Set<number>()
  private netmapPanLast: { x: number; y: number } | null = null
  private netmapDragged = false
  private netmapSuppressClick = false

  /** §15.26: жест на карте закончен (все указатели отпущены) — досрочиваем
   *  отложенный structural render, если он копился под пальцем. */
  private netmapGestureEnd(): void {
    if (this.netmapRenderHeld && this.netmapPointers.size === 0 && this.pinchDist === 0) {
      this.netmapRenderHeld = false
      this.schedule(() => this.render())
    }
  }

  /** §15.29: базовые размеры карты читаются из dataset текущего svg — они
   *  различаются для landscape-полос и ordinary, а зум-состояние переживает
   *  перестройку (в т.ч. поворот экрана). */
  private netmapSvgDims(svg: SVGElement): { w: number; h: number } {
    return {
      w: Number(svg.dataset.w ?? HackView.NETMAP_W),
      h: Number(svg.dataset.h ?? HackView.NETMAP_H),
    }
  }

  private applyNetmapZoom(svg: SVGElement): void {
    const { w: BW, h: BH } = this.netmapSvgDims(svg)
    const vw = BW / this.netmapZoom
    const vh = BH / this.netmapZoom
    // Мягкий clamp центра: видимая область не уходит за базовый прямоугольник
    // карты — пан/зум не вывозят карту в бесконечность. При zoom < 1 (обзор
    // шире базы) центр фиксируется в центре базы.
    const cx = vw >= BW ? BW / 2 : Math.min(BW - vw / 2, Math.max(vw / 2, this.netmapCenter.x))
    const cy = vh >= BH ? BH / 2 : Math.min(BH - vh / 2, Math.max(vh / 2, this.netmapCenter.y))
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
    this.netmapZoom = this.netmapBase() // тап-дабл: к базе ТЕКУЩЕЙ ориентации (§15.29)
    const d = this.netmapSvgDims(svg)
    this.netmapCenter = { x: d.w / 2, y: d.h / 2 }
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
      this.netmapGestureEnd()
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
      this.pinchDist = 0 // §15.26: и пинч — иначе гейт render'а залип бы намертво
      this.netmapGestureEnd()
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
    svg.addEventListener('touchend', (e) => {
      this.pinchDist = 0
      this.netmapGestureEnd()
      // §15.26: с двумя пальцами пан вставал на паузу; вернулся к одному —
      // возобновляем от точки оставшегося, без «мертвого» перемещения.
      if (e.touches.length === 1 && this.netmapPointers.size === 1) {
        const t = e.touches[0]
        this.netmapPanLast = { x: t.clientX, y: t.clientY }
        this.netmapDragged = false
      }
    })
    // §15.26: system-отмена тача (входящий вызов, palm rejection) — pointerup
    // не придёт; без сброса пинч залип бы навсегда заблокировал render.
    svg.addEventListener('touchcancel', () => {
      this.pinchDist = 0
      this.netmapGestureEnd()
    })
    this.applyNetmapZoom(svg)
  }

  /** §15.29: landscape тача — широкая низкая карта, полосы этажей рядом по
   *  горизонтали (на 124px-ленте две горизонтальные полосы превращали сеть в
   *  нечитаемую кашу). Возвращает базовые W/H и признак сайд-полос. */
  private netmapDims(): { w: number; h: number; side: boolean } {
    const land = IS_TOUCH && matchMedia('(orientation: landscape) and (min-width: 600px)').matches
    if (land) return { w: HackView.NETMAP_W_LAND, h: HackView.NETMAP_H_LAND, side: true }
    return { w: HackView.NETMAP_W, h: HackView.NETMAP_H, side: false }
  }

  /** Базовый зум: landscape тача — 1 (вся широкая карта целиком), иначе §15.6. */
  private netmapBase(): number {
    return this.netmapDims().side ? 1 : HackView.NETMAP_ZOOM0
  }

  private buildNetmapSvg(): SVGElement {
    const dim = this.netmapDims()
    const W = dim.w
    const H = dim.h
    const PAD = 40
    const svg = svgEl('svg')
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.dataset.w = String(W)
    svg.dataset.h = String(H)
    svg.classList.add('netmap-svg')
    // §15.29: сменилась ориентация/режим карты между перестройками (поворот
    // экрана) — базовые зум и центр не переживают смену раскроя.
    if (this.netmapLand !== dim.side) {
      this.netmapLand = dim.side
      this.netmapZoom = this.netmapBase()
      this.netmapCenter = { x: W / 2, y: H / 2 }
    }
    this.attachNetmapZoom(svg)

    const nodes = [...this.devices.values()]
    const S = HackView.NETMAP_S
    const label = (x: number, y: number, text: string, cls: string, plate = false): void => {
      // Подложка под подпись узла: полупрозрачная тёмная плашка, чтобы
      // текст не перебивал соседние узлы/подписи (плейтест M3).
      if (plate) {
        const fs = 8 * S
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
      // CSS-класс держит базовый 8px; presentation-атрибут его не перебивает,
      // поэтому тач-увеличение (§15.7) — inline-стилем.
      if (S !== 1) t.style.fontSize = `${8 * S}px`
      t.textContent = text
      svg.append(t)
    }
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string, width?: number): void => {
      const l = svgEl('line')
      l.setAttribute('x1', String(x1))
      l.setAttribute('y1', String(y1))
      l.setAttribute('x2', String(x2))
      l.setAttribute('y2', String(y2))
      // setAttribute, не classList.add: у SVG-элементов classList.add с
      // multi-token строкой ('a b') бросает InvalidCharacterError и рендер
      // карты умирает целиком.
      l.setAttribute('class', cls)
      // через style, не setAttribute: presentation-атрибут перебивается
      // CSS-правилами .svg-link/.svg-riser (плейтест M5: толщины «не работали»)
      if (width !== undefined) l.style.strokeWidth = String(Math.round(width * 100) / 100)
      svg.append(l)
    }

    if (nodes.length === 0) {
      label(W / 2, H / 2, 'ТУМАН ВОЙНЫ — PORTSCAN [1]', 'svg-dim')
      return svg
    }

    // Проекция мировые XZ→экран. Multi-floor (M4 §13.3.1, ред. плейтеста:
    // ярусы НЕ должны пересекаться — никакой ISO-накидки поверх плана):
    // каждый ярус получает свою горизонтальную полосу и свой fit по своему
    // bbox — полосы не пересекаются по построению, а стояк между этажами —
    // мост между ними (голубой пунктир). M5-ревизия 1.5 (плейтест): ЯРУСОВ
    // ДВА — порог один y<4 → Э1, остальное Э2. Прежний порог y<11 создавал
    // фантомный «Э3»: настенный клапан v3 (подвес y=14.1 под крышей отсека)
    // уезжал на несуществующий этаж. Одноэтажная сеть = одна полоса.
    const levelOf = (y: number): number => (y < 4 ? 0 : 1)
    const levels = [...new Set(nodes.map((d) => levelOf(d.y)))].sort((a, b) => a - b)
    const shelfIdx = new Map<number, number>() // levelOf → индекс снизу (0=низ)
    levels.forEach((lv, i) => shelfIdx.set(lv, i))
    // §15.29 side: полосы — ВЕРТИКАЛЬНЫЕ колонки рядом по ширине. Одна
    // широкая полоса на весь canvas, когда ярус один (частичный скан).
    const SIDE_GAP = 18
    const BAND_GAP_V = 16
    const bandW = dim.side ? (W - 16 - SIDE_GAP * (levels.length - 1)) / levels.length : W
    // side: вертикальный extent колонки (bandTop=10..H-8); полосы: прежний расчёт
    const bandH = dim.side ? H - 18 : (H - 20 - 28 - BAND_GAP_V * (levels.length - 1)) / levels.length
    const fits = new Map<number, { k: number; ox: number; oz: number; bandTop: number; bandLeft: number }>()
    for (const lv of levels) {
      const s = shelfIdx.get(lv) ?? 0
      let bx0: number, innerTop: number, innerBottom: number, bandTop: number
      if (dim.side) {
        bx0 = 8 + s * (bandW + SIDE_GAP)
        bandTop = 10
        innerTop = 28 // строка «ЭN» сверху колонки
        innerBottom = H - 8
      } else {
        const bandBottom = H - 20 - s * (bandH + BAND_GAP_V)
        bandTop = bandBottom - bandH
        bx0 = 0
        innerTop = bandTop + 18 // строка «ЭN» сверху полосы
        innerBottom = bandBottom - 6
      }
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
      const usable = dim.side ? bandW - 20 : W - PAD * 2 - 30
      const k = Math.min(usable / sx, (innerBottom - innerTop) / sz)
      fits.set(lv, {
        k,
        ox: (dim.side ? bx0 + 10 + (bandW - 20 - sx * k) / 2 : PAD + 14 + (W - PAD * 2 - 30 - sx * k) / 2) - lx0 * k,
        oz: innerTop + (innerBottom - innerTop - sz * k) / 2 - lz0 * k,
        bandTop,
        bandLeft: bx0,
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

    // Дека участвует в declutter наравне с устройствами (плейтест M4: иначе
    // жёсткое смещение «40 px влево от хоста» попадает в кучу раздвинутых
    // нод, и маркер «куда подключился» не виден среди узлов). Дека —
    // псевдо-узел DECK_ID: старт рядом с хостом, дальше общая раздвижка.
    const DECK_ID = '__deck'
    const hostDev = this.devices.get(this.host)
    const hostLevel = hostDev !== undefined ? levelOf(hostDev.y) : null
    const hostPos = hostDev !== undefined ? pos.get(hostDev.id) : undefined
    if (hostPos !== undefined && hostLevel !== null) {
      const hf = fits.get(hostLevel)
      const bandTop = hf?.bandTop ?? 10
      const dirY = bandTop + bandH / 2 - hostPos.y >= 0 ? 1 : -1
      // §15.29 side: дека клампится в СВОЮ колонку, не в общий canvas
      const bxL = (hf?.bandLeft ?? 0) + (dim.side ? 14 : 20)
      const bxR = (hf?.bandLeft ?? 0) + bandW - (dim.side ? 14 : 20)
      const deckX = Math.max(bxL, Math.min(bxR, hostPos.x - 40))
      const deckY = Math.max(
        bandTop + 10,
        Math.min(bandTop + bandH - 6, hostPos.y + dirY * (Math.abs(hostPos.x - deckX) < 12 ? 36 : 18)),
      )
      pos.set(DECK_ID, { x: deckX, y: deckY })
    }

    const bodies = hostPos !== undefined ? [...nodes.map((d) => ({ id: d.id, lv: levelOf(d.y) })), { id: DECK_ID, lv: hostLevel as number }] : nodes.map((d) => ({ id: d.id, lv: levelOf(d.y) }))
    // MIN_DIST 34 и 24 прохода (M5-ревизия 1.5, плейтест: подпись R1
    // перекрывалась CAM1) + добивка после клампа ниже.
    const MIN_DIST = 34 * S
    for (let pass = 0; pass < 24; pass++) {
      let maxPush = 0
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = pos.get(bodies[i].id)
          const b = pos.get(bodies[j].id)
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
    // §15.29 side: по X — внутри своей колонки, а не всего canvas.
    for (const b of bodies) {
      const p = pos.get(b.id)
      const f = fits.get(b.lv)
      if (p === undefined || f === undefined) continue
      p.x = dim.side
        ? Math.max(f.bandLeft + 14, Math.min(f.bandLeft + bandW - 14, p.x))
        : Math.max(14, Math.min(W - 14, p.x))
      p.y = Math.max(f.bandTop + 10, Math.min(f.bandTop + bandH - 6, p.y))
    }
    // Добивка после клампа (M5-ревизия 1.5, плейтест: R1 перекрывалась
    // CAM1 у границы полосы): клампа могла свести раздвинутые узлы обратно,
    // у границы прижимает к стенке, а не к соседу — повторная раздвижка
    // с вертикальным смещением пары.
    for (let pass = 0; pass < 8; pass++) {
      let moved = false
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = pos.get(bodies[i].id)
          const b = pos.get(bodies[j].id)
          if (a === undefined || b === undefined || bodies[i].lv !== bodies[j].lv) continue
          const d = Math.hypot(b.x - a.x, b.y - a.y)
          if (d >= MIN_DIST) continue
          // вертикальная разведёнка: у полосы чаще некуда идти по X
          const dy = (a.y <= b.y ? -1 : 1) * (MIN_DIST - Math.max(d, 2)) / 2
          a.y = Math.max(a.y + dy, 0)
          b.y = Math.max(b.y - dy, 0)
          moved = true
        }
      }
      if (!moved) break
    }
    // и финальный кламп (без повторной раздвижки — хотя бы не за краем)
    for (const b of bodies) {
      const p = pos.get(b.id)
      const f = fits.get(b.lv)
      if (p === undefined || f === undefined) continue
      p.y = Math.max(f.bandTop + 10, Math.min(f.bandTop + bandH - 6, p.y))
    }

    // Полосы этажей: подложка на всю ширину + подпись. Рисуем до связей —
    // фон. Стояк c9 виден поверх полос и читается как «вертикаль сквозь
    // перекрытия».
    for (const lv of levels) {
      const f = fits.get(lv)
      if (f === undefined) continue
      const r = svgEl('rect')
      // §15.29 side: подложка — своя колонка, а не вся ширина
      r.setAttribute('x', String(dim.side ? f.bandLeft : 8))
      r.setAttribute('y', String(f.bandTop))
      r.setAttribute('width', String(dim.side ? bandW : W - 16))
      r.setAttribute('height', String(bandH))
      r.setAttribute('rx', '8')
      r.setAttribute('fill', 'rgba(55,255,155,0.03)')
      r.setAttribute('stroke', 'rgba(55,255,155,0.28)')
      r.setAttribute('stroke-dasharray', '3 5')
      svg.append(r)
      const t = svgEl('text')
      t.setAttribute('x', String(dim.side ? f.bandLeft + 10 : 18))
      t.setAttribute('y', String(f.bandTop + 12))
      t.setAttribute('fill', '#4fae8b')
      t.setAttribute('font-size', String(Math.round(9 * S)))
      t.textContent = `Э${lv + 1}`
      svg.append(t)
    }

    // связи (дедуп по паре); координаты — после declutter. Связь между
    // полками (стояк c9 s2→s3) — отдельный голубой пунктир: читается как
    // «сквозь перекрытие», а не как соседство на плане (§13.3.1).
    // M5-ревизия 1.5 (плейтест): ТОЛЩИНА линии = bw канала (§16.3) —
    // магистраль 40 заметно жирнее ветки 10 и радио-пунктира 5.
    const linkMbps = (a: ScanDevice, b: ScanDevice): number => {
      const e = a.net?.find((n) => n.id === b.id) ?? b.net?.find((n) => n.id === a.id)
      return e !== undefined && e.mbps > 0 ? e.mbps : 20
    }
    const bwWidth = (mbps: number): number => (1 + mbps / 10) * S
    const seen = new Set<string>()
    const drawLink = (a: ScanDevice, b: ScanDevice): void => {
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
      if (seen.has(key)) return
      seen.add(key)
      const pa = pos.get(a.id)
      const pb = pos.get(b.id)
      if (pa === undefined || pb === undefined) return
      const w = bwWidth(linkMbps(a, b))
      if (levelOf(a.y) !== levelOf(b.y)) {
        line(pa.x, pa.y, pb.x, pb.y, 'svg-link svg-riser', w)
        return
      }
      const wireless = a.kind === 'radio' || b.kind === 'radio'
      line(pa.x, pa.y, pb.x, pb.y, wireless ? 'svg-link svg-wireless' : 'svg-link', w)
    }
    for (const d of nodes) {
      for (const l of d.links) {
        const o = this.devices.get(l)
        if (o !== undefined) drawLink(d, o)
      }
    }

    // Каналы активных операций (плейтест M5: «подсветить путь, по которому
    // идёт операция»): маршрут widest-path из deck-сообщения 2 Гц (прислал
    // сервер, зафиксирован на старте §16.3). Рисуем ПОВЕРХ обычных связей —
    // тот же цвет, ярче и толще; несколько операций — каждая свой слой.
    // Маршрут начинается с точки входа (deck→host не рисуем — это не канал).
    // §15.26: слой живёт отдельно (drawNetmapHi) — deck-тик не rebuild-ит
    // каркас карты и не рвёт жест пальца. Группа на месте прежнего блока —
    // z-порядок прежний: поверх связей, под дека-линком и узлами.
    const hiLayer = svgEl('g')
    svg.append(hiLayer)
    this.drawNetmapHi(hiLayer, pos)
    this.netmapHi.set(svg, { g: hiLayer, pos })

    // Дека — узел РЯДОМ с точкой джек-ина (плейтест M4: в углу она «вне
    // этажей», а смысл — «откуда сижу»): позиция прошла общую раздвижку
    // declutter (см. выше), так что маркер не тонет в куче нод. Подпись —
    // ДЕКА·ID, двойной круг — «ты здесь».
    const deckPos = hostDev !== undefined ? pos.get(DECK_ID) : undefined
    const hostPosFinal = hostDev !== undefined ? pos.get(hostDev.id) : undefined
    if (deckPos !== undefined && hostPosFinal !== undefined && hostDev !== undefined) {
      line(deckPos.x, deckPos.y, hostPosFinal.x, hostPosFinal.y, 'svg-link svg-link-deck')
      const halo = svgEl('circle')
      halo.setAttribute('cx', String(deckPos.x))
      halo.setAttribute('cy', String(deckPos.y))
      halo.setAttribute('r', String(10 * S))
      halo.setAttribute('fill', 'none')
      halo.setAttribute('stroke', 'rgba(55,255,155,0.45)')
      halo.setAttribute('stroke-width', '1')
      halo.setAttribute('stroke-dasharray', '2 3')
      svg.append(halo)
      const deck = svgEl('circle')
      deck.setAttribute('cx', String(deckPos.x))
      deck.setAttribute('cy', String(deckPos.y))
      deck.setAttribute('r', String(6 * S))
      deck.classList.add('svg-deck')
      svg.append(deck)
      label(deckPos.x, deckPos.y + 18 * S, `ДЕКА·${hostDev.id.toUpperCase()}`, 'svg-label-deck', true)
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
        ring.setAttribute('r', String(11 * S))
        ring.classList.add('svg-sel')
        svg.append(ring)
      }
      if (d.vulned === true) {
        const vm = svgEl('circle')
        vm.setAttribute('cx', String(cx))
        vm.setAttribute('cy', String(cy))
        vm.setAttribute('r', String(10 * S))
        vm.classList.add('svg-vulned')
        svg.append(vm)
      }
      // Мой watcher на устройстве — янтарный пунктирный ореол (§13.1).
      if (d.watched === true) {
        const wt = svgEl('circle')
        wt.setAttribute('cx', String(cx))
        wt.setAttribute('cy', String(cy))
        wt.setAttribute('r', String(10 * S))
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
        fw.setAttribute('r', String(15 * S))
        fw.setAttribute('stroke', this.fwColor(by))
        fw.classList.add('svg-firewalled')
        svg.append(fw)
        const badge = svgEl('text')
        badge.setAttribute('x', String(cx))
        badge.setAttribute('y', String(cy - 19 * S))
        badge.setAttribute('text-anchor', 'middle')
        badge.setAttribute('fill', this.fwColor(by))
        badge.setAttribute('font-size', String(Math.round(7 * S)))
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
        av.setAttribute('r', String(12 * S))
        av.classList.add('svg-antivirused')
        svg.append(av)
      }
      // Захваченное устройство: жирное кольцо цвета команды владельца —
      // «это уже моё/ихнее» видно с первого взгляда (плейтест M2).
      if (d.owner !== null) {
        const own = svgEl('circle')
        own.setAttribute('cx', String(cx))
        own.setAttribute('cy', String(cy))
        own.setAttribute('r', String(13 * S))
        own.setAttribute('stroke', this.ownerColor(d.owner))
        own.setAttribute('stroke-width', String((d.owner === this.myId ? 3 : 2) * S))
        own.setAttribute('fill', 'none')
        own.classList.add('svg-owned')
        svg.append(own)
      }
      const c = svgEl('circle')
      c.setAttribute('cx', String(cx))
      c.setAttribute('cy', String(cy))
      c.setAttribute('r', String(7 * S))
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
      label(cx, cy + 19 * S, d.id.toUpperCase(), 'svg-label', true)
    }
    return svg
  }
}
