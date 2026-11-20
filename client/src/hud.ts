// DOM-overlay HUD (no Babylon GUI): join screen, vitals, topbar, killfeed,
// crosshair, respawn overlay, match-end overlay, minimap shell, debug corner.
// Cyberpunk terminal look: monospace, dark panels, cyan/magenta accents.

import { CLASSES } from './classes'
import type { Cls, NetStats, SnapPlayer } from './net'
import { IS_TOUCH } from './mobile'
import QRCode from 'qrcode'

const TEAM_END_LABEL = ['WHITEHAT', 'BLACKHAT'] as const // team 0 = WhiteHat (белая, §2)
/** Лор извлечения (итерация 7, формулировка владельца): ЧТО мы вынесли. */
export const EXTRACT_LORE = 'ИЗВЛЕЧЕНО: ПРОТОКОЛ «ГЕНЕАЛОГИЯ» — КОМПОНЕНТ ВИРУСА, УБИВАЮЩЕГО ПО ДНК НОСИТЕЛЯ И ВСЕХ ЕГО ДЕТЕЙ'
const KILLFEED_ROWS = 5
const KILLFEED_FADE_MS = 4000
const END_RESTART_MS = 30000

/** Текст приглашения (§15.5): три лозунга владельца — каркас текста
 *  (заголовок → разворот → финал), между ними — только реальные механики.
 *  Один «скопировать» даёт готовое сообщение для мессенджера. */
function inviteText(url: string): string {
  return [
    '⚔ HACKSTRIKE // ХАКНИ ИЛИ УМРИ',
    '',
    'Командный кибер-FPS в браузере. BLACKHAT VS WHITEHAT.',
    '',
    'Хакер коннектится по проводам и без — через терминалы и радио-эфир, работает из кибер-деки:',
    'открывает чужие двери, ворует камеры, перетыкает кабели, оставляет',
    'ловушки в сети. Пока он в деке — тело стоит у терминала и беззащитно,',
    'кибердека нагревается от нагрузки, но его мысли быстры, чисты и хладнокровны.',
    '',
    'УБЕЙ ХАКЕРА ИЛИ УМРИ.',
    '',
    'Снайпер ваншотит, автоматчик поливает свинцом, heavy не останавливается.',
    'Жизнь здесь слишком коротка, но интересна — всего 5 секунд до респавна.',
    'Матч на счёт, авторестарт.',
    '',
    'Ничего устанавливать не нужно: открыл ссылку — играешь.',
    `▸ ${url}`,
  ].join('\n')
}

/** Web Share Level 2 умеет отправлять файлы (QR-картинку) вместе с текстом —
 *  на практике это touch-устройства; на десктопе шит бесполезен, там буфер. */
function canShareFiles(): boolean {
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
  const probe = new File([''], 'probe.png', { type: 'image/png' })
  try {
    return navigator.canShare({ files: [probe] })
  } catch {
    return false
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('hud: canvas toBlob failed'))
      else resolve(blob)
    }, 'image/png')
  })
}

function selectInviteUrl(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** Живой netmap-SVG → канвас: сериализуем клон с инжектом минимального
 *  стиля (в DOM текст узлов красится CSS-классами, которых в файле нет).
 *  Не получилось (шрифт/сериализация) — вернём null, заставка соберётся
 *  с процедурной картой. */
async function svgToCanvas(svg: SVGSVGElement): Promise<HTMLCanvasElement | null> {
  try {
    const clone = svg.cloneNode(true) as SVGSVGElement
    const vb = svg.viewBox.baseVal
    const W = vb.width || 480
    const H = vb.height || 360
    clone.setAttribute('width', String(W))
    clone.setAttribute('height', String(H))
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const st = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    st.textContent =
      'text{font-family:ui-monospace,Menlo,monospace}.svg-label-plate{fill:rgba(0,24,12,0.7)}'
    clone.prepend(st)
    const url =
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone))
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('hud: svg raster failed'))
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const ctx = c.getContext('2d')
    if (ctx === null) return null
    ctx.fillStyle = '#041008'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(img, 0, 0)
    return c
  } catch {
    return null
  }
}

/** Процедурная «карта сети»: тёмный фон, сетка, цепочка узлов в цветах
 *  владельцев. Масштаб узлов/сетки привязан к размеру холста — на большой
 *  заставке узлы крупные, а не точечки. Fallback, когда дека ещё ни разу
 *  не открывалась и живого netmap-SVG не существует (join-экран). */
function proceduralNetmap(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (ctx === null) throw new Error('hud: 2d context unavailable')
  ctx.fillStyle = '#041008'
  ctx.fillRect(0, 0, w, h)
  const grid = Math.max(40, Math.round(w / 20))
  ctx.strokeStyle = 'rgba(55, 255, 155, 0.08)'
  for (let x = 0; x < w; x += grid) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
  for (let y = 0; y < h; y += grid) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  const colors = ['#37ff9b', '#f2f2f2', '#37d6ff']
  let seed = 42
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const count = Math.max(10, Math.round((w * h) / 40000))
  const radius = Math.max(9, Math.round(w / 70))
  const pts = Array.from({ length: count }, () => ({
    x: radius * 3 + rnd() * (w - radius * 6),
    y: radius * 2 + rnd() * (h - radius * 4),
  }))
  ctx.strokeStyle = 'rgba(55, 255, 155, 0.45)'
  ctx.lineWidth = Math.max(2, radius / 4)
  for (let i = 1; i < pts.length; i++) {
    ctx.beginPath()
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y)
    ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }
  pts.forEach((p, i) => {
    ctx.fillStyle = colors[i % colors.length]
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(55, 255, 155, 0.8)'
    ctx.lineWidth = 2
    ctx.stroke()
  })
  ctx.lineWidth = 1
  return c
}

function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number): void {
  const iw = 'width' in img ? Number(img.width) : 0
  const ih = 'height' in img ? Number(img.height) : 0
  if (iw <= 0 || ih <= 0) return
  const s = Math.max(w / iw, h / ih)
  ctx.drawImage(img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s)
}

const INVITE_GREEN = '#00ff9c'
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

/** Заставка приглашения (генерится один раз, §15.5): крупный процедурный
 *  нетмап на весь холст как задник, поверх — скриншот meatview (если есть)
 *  и вставка hackview в рамке, титул и лозунг по центру. Ничего не дублируем:
 *  если скриншота нет — задник остаётся единственным фоном. */
function composeSplash(
  meat: HTMLCanvasElement | null,
  hack: HTMLCanvasElement | null,
  url: string,
): HTMLCanvasElement {
  const W = 960
  const H = 540
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')
  if (ctx === null) throw new Error('hud: 2d context unavailable')
  // Задник — процедурный нетмап на весь холст (узлы крупные, см. выше)
  drawCover(ctx, proceduralNetmap(W, H), W, H)
  // Скриншот meatview поверх — с затемнением, чтобы задник проступал
  if (meat !== null) {
    ctx.globalAlpha = 0.85
    drawCover(ctx, meat, W, H)
    ctx.globalAlpha = 1
  }
  // Вставка hackview (живой netmap) в рамке, справа снизу — сверху место
  // под титульный блок
  if (hack !== null) {
    const pw = Math.round(W * 0.38)
    const ph = Math.round((hack.height * pw) / hack.width)
    const px = W - pw - 28
    const py = H - ph - 28
    ctx.save()
    ctx.strokeStyle = 'rgba(55, 255, 155, 0.6)'
    ctx.lineWidth = 2
    ctx.shadowColor = 'rgba(55, 255, 155, 0.4)'
    ctx.shadowBlur = 12
    ctx.strokeRect(px - 1, py - 1, pw + 2, ph + 2)
    ctx.restore()
    ctx.drawImage(hack, 0, 0, hack.width, hack.height, px, py, pw, ph)
  }
  ctx.fillStyle = 'rgba(2, 10, 6, 0.45)'
  ctx.fillRect(0, 0, W, H)
  // Титульный блок — сверху, а не по центру
  ctx.textAlign = 'center'
  ctx.shadowColor = 'rgba(55, 255, 155, 0.8)'
  ctx.shadowBlur = 28
  ctx.fillStyle = INVITE_GREEN
  ctx.font = `bold 72px ${MONO_FONT}`
  ctx.fillText('HACKSTRIKE', W / 2, 118)
  ctx.font = `bold 24px ${MONO_FONT}`
  ctx.fillText('ХАКНИ ИЛИ УМРИ · УБЕЙ ХАКЕРА ИЛИ УМРИ', W / 2, 172)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(190, 255, 225, 0.9)'
  ctx.font = `bold 18px ${MONO_FONT}`
  ctx.fillText(url, W / 2, 214)
  return c
}

/** Десктопная версия: заставка + текст приглашения зелёным одной картинкой.
 *  Telegram Desktop при вставке берёт из буфера что-то одно, поэтому текст
 *  запекаем в саму картинку. */
function composeSplashText(splash: HTMLCanvasElement, url: string): HTMLCanvasElement {
  const wrap = 60
  const lines: string[] = []
  for (const raw of inviteText(url).split('\n')) {
    if (raw === '') lines.push(' ')
    for (let i = 0; i < raw.length; i += wrap) lines.push(raw.slice(i, i + wrap))
  }
  const W = 1000
  const pad = 32
  const lh = 30
  const top = Math.round((splash.height * W) / splash.width)
  const c = document.createElement('canvas')
  c.width = W
  c.height = top + pad + lines.length * lh + pad
  const ctx = c.getContext('2d')
  if (ctx === null) throw new Error('hud: 2d context unavailable')
  ctx.fillStyle = '#041008'
  ctx.fillRect(0, 0, W, c.height)
  ctx.drawImage(splash, 0, 0, W, top)
  ctx.font = `bold 19px ${MONO_FONT}`
  ctx.fillStyle = INVITE_GREEN
  ctx.textAlign = 'center'
  lines.forEach((line, i) => ctx.fillText(line, W / 2, top + pad + lh * (i + 1) - 8))
  return c
}

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (e === null) throw new Error(`hud: missing #${id}`)
  return e as T
}

function buildCards(container: HTMLElement, initial: Cls, onPick: (cls: Cls) => void): void {
  CLASSES.forEach((def, i) => {
    const card = document.createElement('div')
    card.className = 'card' + (def.key === initial ? ' selected' : '')
    card.dataset.cls = def.key // предвыбор на death-оверлее (§15.5)
    // Хоткей выбора (десктоп): цифра 1..4 в углу, клик обрабатывает keydown
    const key = document.createElement('div')
    key.className = 'card-key'
    key.textContent = String(i + 1)
    const name = document.createElement('div')
    name.className = 'card-name'
    name.textContent = def.label
    const weapon = document.createElement('div')
    weapon.className = 'card-weapon'
    weapon.textContent = def.weapon
    const stats = document.createElement('div')
    stats.className = 'card-stats'
    for (const s of [`HP ${def.hp}`, `${def.speed.toFixed(1)} м/с`, `${def.damage} урон`, def.rate]) {
      const span = document.createElement('span')
      span.textContent = s
      stats.append(span)
    }
    const note = document.createElement('div')
    note.className = 'card-note'
    note.textContent = def.note
    card.append(key, name, weapon, stats, note)
    card.addEventListener('click', () => {
      container.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'))
      card.classList.add('selected')
      onPick(def.key)
    })
    container.append(card)
  })
}

export class Hud {
  onJoin: (name: string, cls: Cls, team: number) => void = () => {}
  onRespawn: (cls: Cls) => void = () => {}
  /** Меню паузы (§15.5): «вернуться в бой» — клик по кнопке или фону окна. */
  onResume: () => void = () => {}
  /** Пользовательский масштаб чувствительности взгляда (§15.5); main вешает
   *  на controls.sensScale. Вызывается при инициализации и на каждый input. */
  onSensScale: (k: number) => void = () => {}

  private joinCls: Cls = 'assault'
  /** Меню паузы: карточки классов залочены — живой класс не меняется. */
  private joinCardsLocked = false
  private joinTeam = -1 // -1 = авто-баланс; выбор хранится в localStorage
  private deathCls: Cls = 'assault'
  private mapReady = false
  /** Экран загрузки жив до первого «карта построена» (§15.5). */
  private loadVisible = true
  // Invite-заставка (§15.5): собирается один раз при первом открытии модалки
  private splash: HTMLCanvasElement | null = null
  private splashText: HTMLCanvasElement | null = null
  private splashPromise: Promise<void> | null = null
  private respawnAtMs = 0
  private deathActive = false
  private deathReady = false
  private endActive = false
  private endUntilMs = 0
  private onEndDone: (() => void) | null = null

  private readonly el = {
    join: byId('joinScreen'),
    name: byId<HTMLInputElement>('nameInput'),
    invertY: byId<HTMLInputElement>('invertY'),
    lookSens: byId<HTMLInputElement>('lookSens'),
    lookSensVal: byId('lookSensVal'),
    ctlScale: byId<HTMLInputElement>('ctlScale'),
    ctlScaleVal: byId('ctlScaleVal'),
    tapScale: byId<HTMLInputElement>('tapScale'),
    tapScaleVal: byId('tapScaleVal'),
    settingsBtn: byId('settingsBtn'),
    settings: byId('joinSettings'),
    settingsClose: byId('settingsClose'),
    deploy: byId<HTMLButtonElement>('deployBtn'),
    resume: byId<HTMLButtonElement>('resumeBtn'),
    joinStatus: byId('joinStatus'),
    joinCards: byId('joinCards'),
    loading: byId('loadingScreen'),
    loadFill: byId('loadFill'),
    loadStatus: byId('loadStatus'),
    inviteBtn: byId('inviteBtn'),
    invite: byId('joinInvite'),
    inviteQr: byId<HTMLCanvasElement>('inviteQr'),
    inviteGallery: byId('inviteGallery'),
    invSlideQr: byId('invSlideQr'),
    inviteShotImg: byId<HTMLImageElement>('inviteShotImg'),
    inviteSplashText: byId<HTMLImageElement>('inviteSplashText'),
    inviteUrl: byId('inviteUrl'),
    inviteCopy: byId<HTMLButtonElement>('inviteCopy'),
    inviteShare: byId<HTMLButtonElement>('inviteShare'),
    inviteQrCopy: byId<HTMLButtonElement>('inviteQrCopy'),
    inviteClose: byId('inviteClose'),
    death: byId('deathOverlay'),
    deathTitle: byId('deathTitle'),
    deathCount: byId('deathCount'),
    deathCards: byId('deathCards'),
    respawn: byId<HTMLButtonElement>('respawnBtn'),
    end: byId('endOverlay'),
    endTitle: byId('endTitle'),
    endScore: byId('endScore'),
    endCount: byId('endCount'),
    hpFill: byId('hpfill'),
    hpNum: byId('hpNum'),
    clsLabel: byId('clsLabel'),
    score0: byId('score0'),
    score1: byId('score1'),
    timer: byId('timer'),
    propLabel: byId('propLabel'),
    weaponTag: byId('weaponTag'),
    roster0: byId('roster0'),
    roster1: byId('roster1'),
    teamSeg: byId('teamSeg'),
    killfeed: byId('killfeed'),
    crosshair: byId('crosshair'),
    scope: byId('scope'),
    hitmarker: byId('hitmarker'),
    dmg: byId('dmg'),
    status: byId('status'),
    tick: byId('tick'),
    players: byId('players'),
    rtt: byId('rtt'),
    snaps: byId('snaps'),
    jackinHint: byId('jackinHint'),
    hudWarn: byId('hudWarn'),
    hudCode: byId('hudCode'),
    endReason: byId('endReason'),
    hudNav: byId('hudNav'),
    hudCarry: byId('hudCarry'),
    hudChannel: byId('hudChannel'),
    hudChannelTitle: byId('hudChannelTitle'),
    hudChannelFill: byId('hudChannelFill'),
    hudChannelPct: byId('hudChannelPct'),
    endTable: byId('endTable'),
  }

  /** Vertical mouse inversion, persisted across sessions (client-side only). */
  get invertYOn(): boolean {
    return this.el.invertY.checked
  }

  /** Множитель чувствительности взгляда (0.3..4.0, слайдер §15.5). */
  get lookScale(): number {
    return Math.min(4, Math.max(0.3, Number(this.el.lookSens.value) / 100))
  }

  /** §15.21: load и apply РАЗДЕЛЕНЫ. Реგრессия f6ae181: reapplySens делал и
   *  то и то, а вешался на input — перетянутое значение мгновенно откатывалось
   *  к сохранённому (snap-back, «слайдеры не двигаются»). Load (reapply*) —
   *  только на загрузке после wiring и на deploy; input вешает apply*. */
  private applySens(): void {
    localStorage.setItem('hs.lookSens', this.el.lookSens.value)
    this.el.lookSensVal.textContent = `${this.lookScale.toFixed(1)}×`
    this.onSensScale(this.lookScale)
  }

  reapplySens(): void {
    const saved = Number(localStorage.getItem('hs.lookSens'))
    if (Number.isFinite(saved) && saved >= 30 && saved <= 400) {
      this.el.lookSens.value = String(saved)
    }
    this.applySens()
  }

  /** Множитель размера мобильных контролов (0.75..1.5, слайдер §15.16):
   *  стик/прицел/ДЕЙСТВИЕ масштабятся через CSS --ctl на :root; зона тапа
   *  растет вместе с картинкой (хит-тест стика — getBoundingClientRect). */
  get ctlScaleK(): number {
    return Math.min(1.5, Math.max(0.75, Number(this.el.ctlScale.value) / 100))
  }

  /** §15.21: те же load/apply, что у сенсы (та же snap-back-ловушка). */
  private applyCtl(): void {
    localStorage.setItem('hs.ctlScale', this.el.ctlScale.value)
    const k = this.ctlScaleK
    this.el.ctlScaleVal.textContent = `${k.toFixed(2).replace(/0$/, '')}×`
    document.documentElement.style.setProperty('--ctl', String(k))
  }

  reapplyCtl(): void {
    const saved = Number(localStorage.getItem('hs.ctlScale'))
    if (Number.isFinite(saved) && saved >= 75 && saved <= 150) {
      this.el.ctlScale.value = String(saved)
    }
    this.applyCtl()
  }

  /** Множитель зоны тапа (1.0..1.8, §15.18): хит-тест контролов шире самой
   *  картинки (::after-рамка в CSS), картинка не меняется. */
  get tapScaleK(): number {
    return Math.min(1.8, Math.max(1, Number(this.el.tapScale.value) / 100))
  }

  /** §15.21: тач-слой для range — Safari не поддерживает drag бегунка пальцем
   *  родным жестом; ставим значение по X-позиции указателя и шлём input.
   *  Десктоп не затронут (вызываемся только под IS_TOUCH). */
  private enableTouchDrag(r: HTMLInputElement): void {
    const setFromPointer = (clientX: number): void => {
      const b = r.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (clientX - b.left) / b.width))
      const min = Number(r.min), max = Number(r.max), step = Number(r.step) || 1
      const raw = min + frac * (max - min)
      const stepped = Math.round(raw / step) * step
      r.value = String(Math.min(max, Math.max(min, stepped)))
      r.dispatchEvent(new Event('input', { bubbles: true }))
    }
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try {
        r.setPointerCapture(e.pointerId)
      } catch {
        /* синтетический указатель без активного pointerId — просто ставим */
      }
      setFromPointer(e.clientX)
    })
    r.addEventListener('pointermove', (e) => {
      if (!r.hasPointerCapture(e.pointerId)) return
      e.preventDefault()
      setFromPointer(e.clientX)
    })
  }

  private applyTap(): void {
    localStorage.setItem('hs.tapScale', this.el.tapScale.value)
    const k = this.tapScaleK
    this.el.tapScaleVal.textContent = `${k.toFixed(1)}×`
    document.documentElement.style.setProperty('--tap', String(k))
  }

  reapplyTap(): void {
    const saved = Number(localStorage.getItem('hs.tapScale'))
    if (Number.isFinite(saved) && saved >= 100 && saved <= 180) {
      this.el.tapScale.value = String(saved)
    }
    this.applyTap()
  }

  constructor() {
    // Меню паузы (§15.5) — то же join-окно, но живой игрок класс сменить не
    // может (сервер применяет cls только на респауне); карточки блокируем,
    // чтобы «тыкаю, а ничего не меняется» не вводило в заблуждение.
    buildCards(this.el.joinCards, this.joinCls, (c) => {
      if (this.joinCardsLocked) return
      this.joinCls = c
    })
    buildCards(this.el.deathCards, this.deathCls, (c) => (this.deathCls = c))
    this.el.invertY.checked = localStorage.getItem('hs.invertY') === '1'
    this.reapplySens()
    this.el.lookSens.addEventListener('input', () => this.applySens())
    this.reapplyCtl()
    this.el.ctlScale.addEventListener('input', () => this.applyCtl())
    this.reapplyTap()
    this.el.tapScale.addEventListener('input', () => this.applyTap())
    // §15.21: iOS Safari не тянет бегунок range пальцем (только тап по треку)
    // — touch-слой на Pointer Events. touch-action:none на body.touch (§15.18)
    // отдаёт жест слайдеру, pointermove льётся непрерывно.
    if (IS_TOUCH) {
      for (const r of [this.el.lookSens, this.el.ctlScale, this.el.tapScale]) this.enableTouchDrag(r)
    }
    // Единый экран настроек (§15.5): кнопка под ДЕПЛОЕМ → модалка; клик по
    // затемнению и ESC закрывают. Одна механика на desktop и touch.
    this.el.settingsBtn.addEventListener('click', () => this.el.settings.classList.remove('hidden'))
    // §15.22: кнопка «ПРИМЕНИТЬ» — честный смысл: прогоняет apply* (идемпотентно,
    // значения и так live на input) и закрывает панель.
    this.el.settingsClose.addEventListener('click', () => {
      this.applySens()
      this.applyCtl()
      this.applyTap()
      this.el.settings.classList.add('hidden')
    })
    this.el.settings.addEventListener('click', (e) => {
      if (e.target === this.el.settings) this.el.settings.classList.add('hidden')
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.el.settings.classList.add('hidden')
        this.el.invite.classList.add('hidden')
      }
      // Хоткеи команд A/W/B (десктоп, по e.code — любая раскладка): кликаем
      // сегмент команды на join. Из поля ника — не перехватываем.
      if (!this.el.join.classList.contains('hidden') && !e.repeat) {
        const teamByCode: Record<string, string> = { KeyA: '-1', KeyW: '0', KeyB: '1' }
        const team = teamByCode[e.code]
        if (
          team !== undefined &&
          !(e.target instanceof HTMLElement && e.target.closest('input') !== null)
        ) {
          this.el.teamSeg.querySelector<HTMLButtonElement>(`[data-team="${team}"]`)?.click()
          return
        }
      }
      // Хоткеи классов 1..4 (десктоп): кликаем карточку на видимом наборе —
      // join до деплоя, death-оверлей после гибели. Порядок = CLASSES.
      const idx = ['1', '2', '3', '4'].indexOf(e.key)
      if (idx === -1) return
      const cont =
        !this.el.join.classList.contains('hidden') ? this.el.joinCards : this.el.deathCards
      if (cont.classList.contains('hidden')) return
      cont.querySelectorAll<HTMLElement>('.card')[idx]?.click()
    })
    // Enter в join-окне = ДЕПЛОЙ (в том числе прямо из поля ника). В меню
    // паузы деплой скрыт — Enter там ничего не делает.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat) return
      if (this.el.join.classList.contains('hidden')) return
      if (this.el.deploy.classList.contains('hidden')) return
      if (!this.el.deploy.disabled) this.deploy()
    })
    // Приглашение (§15.5): QR + ссылка на текущий origin. URL считаем на
    // момент открытия — стенд может переехать между открытиями (zrok и т.п.).
    this.el.inviteBtn.addEventListener('click', () => {
      const url = `${window.location.origin}${window.location.pathname}`
      this.el.inviteUrl.textContent = url
      QRCode.toCanvas(this.el.inviteQr, url, { width: 180, margin: 1 }).catch((err) => {
        console.warn('hud: qr render failed', err)
      })
      // Мобила = тач + Web Share Level 2 с файлами: там свайп-галерея
      // QR ↔ заставка и «поделиться». Десктопный Chrome тоже умеет share —
      // поэтому тач-проверка обязательна, иначе на десктопе лезет не тот UI.
      const mobile = navigator.maxTouchPoints > 0 && canShareFiles()
      this.el.inviteShare.classList.toggle('hidden', !mobile)
      this.el.inviteQrCopy.classList.toggle('hidden', mobile)
      this.el.inviteGallery.classList.toggle('hidden', !mobile)
      this.el.inviteSplashText.classList.toggle('hidden', mobile)
      this.el.invite.classList.remove('hidden')
      void this.ensureSplash()
    })
    this.el.inviteShare.addEventListener('click', () => {
      const url = this.el.inviteUrl.textContent
      this.ensureSplash()
        .then(() => {
          if (this.splash === null) throw new Error('hud: splash not ready')
          return canvasToBlob(this.splash)
        })
        .then((blob) => {
          const file = new File([blob], 'hackstrike-invite.png', { type: 'image/png' })
          return navigator.share({ files: [file], text: inviteText(url), title: 'HACKSTRIKE' })
        })
        .catch((err) => console.warn('hud: share failed', err))
    })
    this.el.inviteQrCopy.addEventListener('click', () => {
      const done = (): void => {
        this.el.inviteQrCopy.textContent = 'СКОПИРОВАНО ✓'
        window.setTimeout(() => {
          this.el.inviteQrCopy.textContent = 'КОПИРОВАТЬ КАРТИНКУ'
        }, 1500)
      }
      this.ensureSplash()
        .then(() => {
          if (this.splashText === null) throw new Error('hud: splash not ready')
          return canvasToBlob(this.splashText)
        })
        .then((blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
        .then(done)
        .catch(() => {
          // Fallback на http/старых браузерах: картинку в буфер не положить —
          // просто выделяем ссылку, чтобы юзер скопировал её вручную.
          selectInviteUrl(this.el.inviteUrl)
        })
    })
    this.el.inviteClose.addEventListener('click', () => this.el.invite.classList.add('hidden'))
    this.el.invite.addEventListener('click', (e) => {
      if (e.target === this.el.invite) this.el.invite.classList.add('hidden')
    })
    this.el.inviteCopy.addEventListener('click', () => {
      const done = (): void => {
        this.el.inviteCopy.textContent = 'СКОПИРОВАНО ✓'
        window.setTimeout(() => {
          this.el.inviteCopy.textContent = 'СКОПИРОВАТЬ'
        }, 1500)
      }
      const url = this.el.inviteUrl.textContent
      navigator.clipboard
        .writeText(inviteText(url))
        .then(done)
        .catch(() => {
          // Fallback (clipboard API запрещён на http-стендах): выделение —
          // копирование вручную через контекстное меню.
          selectInviteUrl(this.el.inviteUrl)
        })
    })
    for (const btn of this.el.teamSeg.querySelectorAll<HTMLButtonElement>('.segBtn')) {
      if (Number(btn.dataset.team) === Number(localStorage.getItem('hs.team'))) {
        this.joinTeam = Number(btn.dataset.team)
      }
      btn.addEventListener('click', () => {
        this.joinTeam = Number(btn.dataset.team)
        localStorage.setItem('hs.team', String(this.joinTeam))
        for (const b of this.el.teamSeg.querySelectorAll('.segBtn')) b.classList.toggle('on', b === btn)
      })
    }
    this.el.teamSeg
      .querySelectorAll('.segBtn')
      .forEach((b) => b.classList.toggle('on', Number((b as HTMLButtonElement).dataset.team) === this.joinTeam))
    this.el.invertY.addEventListener('change', () => {
      localStorage.setItem('hs.invertY', this.el.invertY.checked ? '1' : '0')
    })
    this.el.name.addEventListener('input', () => this.refreshDeploy())
    this.el.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.deploy()
    })
    this.el.deploy.addEventListener('click', () => this.deploy())
    this.el.resume.addEventListener('click', () => this.onResume())
    // Тап по фону join-окна = «вернуться в бой» (main решает, в меню ли мы)
    this.el.join.addEventListener('click', (e) => {
      if (e.target === this.el.join) this.onResume()
    })
    // На touch [SPACE]-подсказка в лейбле — шум: кнопка и так тапается (§15.5)
    if (IS_TOUCH) this.el.respawn.textContent = 'РЕСПАУН'
    this.el.respawn.addEventListener('click', () => this.respawnNow())
    // SPACE = respawn hotkey, but only once the countdown is over (and only
    // while the death overlay is up — in-game Space stays the interact key).
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.deathActive && this.deathReady && !this.el.respawn.disabled) {
        e.preventDefault()
        this.respawnNow()
      }
    })
  }

  private respawnNow(): void {
    this.el.respawn.disabled = true // wait for the server to confirm
    this.onRespawn(this.deathCls)
  }

  private deploy(): void {
    this.reapplySens() // гарантии нет, что wiring уже отработал — применяем на входе (§15.5)
    const name = this.el.name.value.trim() || 'hack'
    localStorage.setItem('hs.name', name) // не генерировать заново при каждом заходе
    this.onJoin(name, this.joinCls, this.joinTeam)
  }

  private refreshDeploy(): void {
    this.el.deploy.disabled = !this.mapReady || this.el.name.value.trim().length === 0
  }

  showJoin(): void {
    this.el.join.classList.remove('hidden')
    if (this.el.name.value === '') {
      // Saved name first (persisted on deploy); fresh hack_XXX only once.
      const saved = localStorage.getItem('hs.name')
      this.el.name.value = saved && saved.trim() ? saved : `hack_${Math.floor(100 + Math.random() * 900)}`
    }
    this.refreshDeploy()
  }

  hideJoin(): void {
    this.el.join.classList.add('hidden')
  }

  /** Меню паузы (§15.5): то же join-окно в середине матча. ДЕПЛОЙ скрыт —
   *  повторный джойн из меню не нужен; вместо него «ВЕРНУТЬСЯ В БОЙ». */
  showMenu(): void {
    this.showJoin()
    this.el.deploy.classList.add('hidden')
    this.el.resume.classList.remove('hidden')
    this.joinCardsLocked = true
    this.el.joinCards.classList.add('locked')
  }

  hideMenu(): void {
    this.el.deploy.classList.remove('hidden')
    this.el.resume.classList.add('hidden')
    this.joinCardsLocked = false
    this.el.joinCards.classList.remove('locked')
    this.hideJoin()
  }

  joinVisible(): boolean {
    return !this.el.join.classList.contains('hidden')
  }

  /** Игрок мёртв — death-оверлей показан; меню паузы поверх него не открываем. */
  deathVisible(): boolean {
    return !this.el.death.classList.contains('hidden')
  }

  /** Стадия загрузки (§15.5): pct 0..100, пока экран не погашен — иначе noop. */
  /** Заставка приглашения: один раз на сессию. Скриншоты meatview
   *  (renderCanvas, preserveDrawingBuffer) и hackview (живой netmap-SVG,
   *  если дека уже открывалась — иначе процедурная карта). */
  private ensureSplash(): Promise<void> {
    if (this.splashPromise !== null) return this.splashPromise
    this.splashPromise = (async () => {
      const url = this.el.inviteUrl.textContent || `${window.location.origin}/`
      const meat = document.getElementById('renderCanvas') as HTMLCanvasElement | null
      const svg = document.querySelector('.netmap-svg') as SVGSVGElement | null
      const hack = svg !== null ? await svgToCanvas(svg) : null
      this.splash = composeSplash(meat, hack, url)
      this.splashText = composeSplashText(this.splash, url)
      this.el.inviteShotImg.src = this.splash.toDataURL('image/png')
      this.el.inviteSplashText.src = this.splashText.toDataURL('image/png')
    })()
    return this.splashPromise
  }

  setLoading(pct: number, text?: string): void {
    if (!this.loadVisible) return
    this.el.loadFill.style.width = `${Math.max(0, Math.min(100, pct))}%`
    if (text !== undefined) this.el.loadStatus.textContent = text
  }

  /** Карта построена, мир готов — гасим загрузку, join уже собран под ней. */
  hideLoading(): void {
    if (!this.loadVisible) return
    this.loadVisible = false
    this.el.loadFill.style.width = '100%'
    this.el.loadStatus.textContent = 'ГОТОВО'
    window.setTimeout(() => this.el.loading.classList.add('gone'), 250)
  }

  setMapStatus(text: string | null): void {
    this.el.joinStatus.textContent = text ?? ''
    this.mapReady = text === null
    // Пока виден экран загрузки, статусы карты дублируем в его прогресс:
    // пользователь смотрит именно туда (§15.5).
    if (this.loadVisible) this.setLoading(text === null ? 80 : 60, text ?? 'ЗАГРУЗКА КАРТЫ…')
    this.refreshDeploy()
  }

  setVitals(hp: number, maxHp: number, clsLabel: string): void {
    const pct = Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100))
    this.el.hpFill.style.width = `${pct}%`
    this.el.hpFill.classList.toggle('low', hp <= 30)
    this.el.hpNum.textContent = String(Math.max(0, Math.round(hp)))
    this.el.clsLabel.textContent = clsLabel
  }

  setScores(scores: readonly [number, number], timeLeftSec: number): void {
    this.el.score0.textContent = String(scores[0])
    this.el.score1.textContent = String(scores[1])
    const m = Math.floor(timeLeftSec / 60)
    const s = Math.floor(timeLeftSec % 60)
    this.el.timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  crosshairLocked(on: boolean): void {
    this.el.crosshair.classList.toggle('locked', on)
  }

  private hintText: string | null = null
  private hintProgress = -1
  private hintError = false
  private warnTimer: ReturnType<typeof setTimeout> | undefined = undefined

  /** «SPACE — ДЖЕК-ИН» над прицелом, когда хакер у терминала/радио (M2). */
  jackinHint(text: string | null, progress = -1, error = false): void {
    if (this.hintText === text && progress === this.hintProgress && error === this.hintError) return // called every frame — dedupe
    this.hintText = text
    this.hintProgress = progress
    this.hintError = error
    if (text === null) {
      this.el.jackinHint.classList.add('hidden')
    } else {
      this.el.jackinHint.textContent = text
      this.el.jackinHint.classList.remove('hidden')
      // §12.1 «дорогой вход»: фон подсказки — полоска прогресса канала
      // (заливка слева направо через CSS-var --jp, 0..1; <0 = без полоски).
      if (progress >= 0) {
        this.el.jackinHint.style.setProperty('--jp', String(Math.min(1, Math.max(0, progress))))
        this.el.jackinHint.classList.add('hv-channel')
      } else {
        this.el.jackinHint.style.removeProperty('--jp')
        this.el.jackinHint.classList.remove('hv-channel')
      }
      // не-хакер у устройства нажал «действие» — тултип мигает красным
      this.el.jackinHint.classList.toggle('hv-error', error)
    }
  }

  /** Предупреждение сервера вне деки (denied enemy_team и т.п., §12.5):
   *  красная плашка под jackinHint, гаснет сама. Повтор — рестарт таймера. */
  warn(text: string): void {
    const el = this.el.hudWarn
    if (el === null) return
    el.textContent = text
    el.classList.remove('hidden')
    if (this.warnTimer !== undefined) clearTimeout(this.warnTimer)
    this.warnTimer = setTimeout(() => el.classList.add('hidden'), 3000)
  }

  /** Канал «вскрываем сейф» (§16.6, плейтест «нужна анимация с процентами»):
   *  янтарный бар для своей команды, красный — враг вскрывает. null — скрыть. */
  setChannel(mine: boolean, text: string, prog: number): void {
    const el = this.el.hudChannel
    if (el === null) return
    el.classList.remove('hidden')
    el.classList.toggle('enemy', !mine)
    this.el.hudChannelTitle.textContent = text
    this.el.hudChannelFill.style.width = `${Math.round(Math.min(1, Math.max(0, prog)) * 100)}%`
    this.el.hudChannelPct.textContent = `${Math.round(prog * 100)}%`
  }

  hideChannel(): void {
    this.el.hudChannel?.classList.add('hidden')
  }

  /** Ноша PHYSAFE (§16.6): постоянная янтарная плашка, пока safe=true. */
  setCarry(on: boolean): void {
    const el = this.el.hudCarry
    if (el === null) return
    el.classList.toggle('hidden', !on)
    if (on) el.textContent = 'СЕЙФ ПРИ ТЕБЕ — ВЕДИ НА БАЗУ · СКОРОСТЬ ×0.5'
  }

  /** Пул edge-индикаторов (§15.14, плейтест «треугольники по краям экрана
   *  с подписями»): маленький цветной треугольник + подпись id на краю
   *  экрана — направление на объект ВНЕ поля зрения. Пересоздания DOM нет:
   *  пул переиспользуется, лишние скрываются. */
  setNav(items: readonly { label: string; color: string; left: number; top: number; deg: number }[]): void {
    const box = this.el.hudNav
    if (box === null) return
    for (let i = 0; i < items.length; i++) {
      let el = this.navPool[i]
      if (el === undefined) {
        el = document.createElement('div')
        el.className = 'nav-ind'
        const tri = document.createElement('div')
        tri.className = 'nav-tri'
        const lab = document.createElement('div')
        lab.className = 'nav-label'
        el.append(tri, lab)
        box.append(el)
        this.navPool.push(el)
      }
      const it = items[i]
      el.classList.remove('hidden')
      el.style.left = `${it.left}px`
      el.style.top = `${it.top}px`
      const tri = el.firstElementChild as HTMLElement
      tri.style.borderBottomColor = it.color
      tri.style.transform = `rotate(${it.deg}deg)`
      ;(el.lastElementChild as HTMLElement).textContent = it.label
    }
    for (let i = items.length; i < this.navPool.length; i++) this.navPool[i].classList.add('hidden')
  }
  private navPool: HTMLElement[] = []

  /** Коды, узнанные командой (§16.4/§16.6/§16.9 codes → HUD «КОД D3: 4731
   *  · СЕЙФ: 8241»): постоянная строка — команда знает код до конца матча.
   *  Оба null — скрыть (новый матч: коды перегенерированы). */
  setCodes(door: string | null, safe: string | null): void {
    const el = this.el.hudCode
    if (el === null) return
    const parts: string[] = []
    if (door !== null) parts.push(`КОД D3: ${door}`)
    if (safe !== null) parts.push(`СЕЙФ: ${safe}`)
    if (parts.length === 0) {
      el.classList.add('hidden')
      return
    }
    el.textContent = parts.join('  ·  ')
    el.classList.remove('hidden')
  }

  /** Текущее оружие (хакер: пистолет) — рядом с HP. */
  setWeapon(text: string | null): void {
    const el = this.el.weaponTag
    if (el === null) return
    el.textContent = text ?? ''
  }

  /** Метка пропса под прицелом («SWITCH S1», «ДВЕРЬ D1 — ЗАКРЫТА»). */
  propLabel(text: string | null): void {
    this.el.propLabel.textContent = text ?? ''
  }

  /** Sniper scope overlay (auto-zoom engaged). */
  scope(on: boolean): void {
    this.el.scope.classList.toggle('hidden', !on)
  }

  /** Own team's frags get a solid team-identity chip (WhiteHat/BlackHat). */
  setTeam(team: number): void {
    this.el.score0.classList.toggle('mine', team === 0)
    this.el.score1.classList.toggle('mine', team === 1)
  }

  private rosterSig = ''

  /** Team rosters under each score: t0/t1 класс на каждом имени (WhiteHat —
   *  белое, BlackHat — чёрное на белой плашке); свой ник — жирным. */
  setRoster(players: readonly SnapPlayer[], myId: number | null): void {
    // класс в сигнатуре: смена класса должна перерисовать ростер
    const sig = players.map((p) => `${p.team}:${p.name}:${p.cls}:${p.alive ? 1 : 0}`).join('|')
    if (sig === this.rosterSig) return
    this.rosterSig = sig
    const clsLabel = (k: string): string => CLASSES.find((c) => c.key === k)?.label ?? k
    const cols = [this.el.roster0, this.el.roster1]
    for (const col of cols) col.textContent = ''
    for (const team of [0, 1] as const) {
      for (const p of players) {
        if (p.team !== team) continue
        const s = document.createElement('span')
        s.classList.add(`t${team}`)
        if (p.id === myId) {
          s.className = 'me'
          s.textContent = `▸ ${p.name} · ${clsLabel(p.cls)}`
        } else {
          s.textContent = `${p.name} · ${clsLabel(p.cls)}`
          if (!p.alive) s.classList.add('dead')
        }
        cols[team].append(s)
      }
    }
  }

  /** White X burst around the crosshair: my shot landed (from shot events). */
  hitmarker(): void {
    this.el.hitmarker.classList.remove('on')
    void this.el.hitmarker.offsetWidth // restart the CSS animation
    this.el.hitmarker.classList.add('on')
  }

  /** Red vignette: the local player just lost HP (hp dropped in a snapshot). */
  damageFlash(): void {
    this.el.dmg.classList.remove('on')
    void this.el.dmg.offsetWidth
    this.el.dmg.classList.add('on')
  }

  killfeed(killer: string, killerTeam: number, victim: string, victimTeam: number): void {
    this.pushKillfeedRow('kf', `t${killerTeam}`, killer, victim, victimTeam)
  }

  /** Смерть от ловушки/среды (M4 §14.2): «ЛОВУШКА» вместо имени — убийства
   *  нет (FF ON, счёт не двигается), строка ядовито-зелёная, жертва — своим. */
  killfeedEnv(victim: string, victimTeam: number): void {
    this.pushKillfeedRow('kf env', 'env', 'ЛОВУШКА', victim, victimTeam, '#7dff50')
  }

  private pushKillfeedRow(
    rowCls: string,
    killerCls: string,
    killer: string,
    victim: string,
    victimTeam: number,
    killerColor?: string,
  ): void {
    const row = document.createElement('div')
    row.className = rowCls
    const k = document.createElement('span')
    k.className = killerCls
    if (killerColor !== undefined) {
      // inline: таблица стилей живёт в index.html (вне src/), а газ без
      // акцентного цвета сливался бы с обычным киллфидом
      k.style.color = killerColor
      k.style.textShadow = '0 0 8px rgba(125, 255, 80, 0.6)'
    }
    k.textContent = killer
    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = ' ▸ '
    const v = document.createElement('span')
    v.className = `t${victimTeam}`
    v.textContent = victim
    row.append(k, arrow, v)
    this.el.killfeed.prepend(row)
    while (this.el.killfeed.children.length > KILLFEED_ROWS) {
      this.el.killfeed.lastElementChild?.remove()
    }
    window.setTimeout(() => {
      row.classList.add('fade')
      window.setTimeout(() => row.remove(), 700)
    }, KILLFEED_FADE_MS)
  }

  /** Сработал watcher (M3 §13.3): янтарная строка в киллфиде — хакер не в деке. */
  alert(text: string): void {
    const row = document.createElement('div')
    row.className = 'kf watcher'
    row.textContent = text
    this.el.killfeed.prepend(row)
    while (this.el.killfeed.children.length > KILLFEED_ROWS) {
      this.el.killfeed.lastElementChild?.remove()
    }
    window.setTimeout(() => {
      row.classList.add('fade')
      window.setTimeout(() => row.remove(), 700)
    }, KILLFEED_FADE_MS)
  }

  showDeath(killer: string, respawnAtMs: number, lastCls?: Cls): void {
    // На touch карточки смерти листать некогда (и непонятно, что они решают):
    // предвыбираем текущий класс, иначе молча возрождаешься assault'ом и
    // джек-ин «пропадает» (§15.5). Десктопное поведение не меняем.
    if (IS_TOUCH && lastCls !== undefined) {
      this.deathCls = lastCls
      for (const c of this.el.deathCards.querySelectorAll<HTMLElement>('.card')) {
        c.classList.toggle('selected', c.dataset.cls === lastCls)
      }
    }
    this.deathActive = true
    this.deathReady = false
    this.respawnAtMs = respawnAtMs
    this.el.deathTitle.textContent = `УБИТ ▸ ${killer}`
    this.el.deathCount.textContent = '5'
    this.el.deathCards.classList.add('hidden')
    this.el.respawn.classList.add('hidden')
    this.el.respawn.disabled = false
    this.el.death.classList.remove('hidden')
  }

  hideDeath(): void {
    if (!this.deathActive) return
    this.deathActive = false
    this.el.death.classList.add('hidden')
  }

  showEnd(
    winner: number,
    scores: readonly [number, number],
    onDone: () => void,
    reason?: string | null,
    players?: readonly { n: string; t: number; f: number }[],
  ): void {
    this.endActive = true
    this.onEndDone = onDone
    this.endUntilMs = Date.now() + END_RESTART_MS
    // плейтест: «Результат: Победа <команда> \ ничья» — явно, словом
    this.el.endTitle.textContent =
      winner === 0 || winner === 1 ? `Результат: ПОБЕДА — ${TEAM_END_LABEL[winner]}` : 'Результат: НИЧЬЯ'
    // ЧТО извлекли (extract) — лорная строка под счётом
    this.el.endReason.textContent = reason ?? ''
    this.el.endReason.classList.toggle('hidden', !reason)
    // таблица фрагов по игрокам (плейтест: «раскрывается с таблицей»)
    const rows = (players ?? []).map((p, i) => {
      const row = document.createElement('div')
      row.className = `end-row t${p.t}`
      row.style.animationDelay = `${0.15 + i * 0.08}s`
      row.append(
        Object.assign(document.createElement('span'), { textContent: `${i + 1}. ${p.n}` }),
        Object.assign(document.createElement('span'), { textContent: String(p.f) }),
      )
      return row
    })
    this.el.endTable.replaceChildren(...rows)
    this.el.endTable.classList.toggle('hidden', rows.length === 0)
    this.el.endTitle.className =
      winner === 0 || winner === 1 ? `end-title t${winner}` : 'end-title'
    this.el.endScore.innerHTML = `<span class="t0">${scores[0]}</span> : <span class="t1">${scores[1]}</span>`
    this.el.endCount.textContent = String(END_RESTART_MS / 1000)
    this.el.end.classList.remove('hidden')
  }

  hideEnd(): void {
    if (!this.endActive) return
    this.endActive = false
    this.el.end.classList.add('hidden')
    const done = this.onEndDone
    this.onEndDone = null
    done?.()
  }

  stats(s: NetStats): void {
    const label = { connecting: 'CONNECTING…', open: 'ONLINE', closed: 'OFFLINE' }[s.status]
    this.el.status.textContent = label
    this.el.status.className = `status-${s.status}`
    this.el.tick.textContent = s.tick > 0 ? String(s.tick) : '—'
    this.el.players.textContent = s.players > 0 ? String(s.players) : '—'
    this.el.rtt.textContent = s.rttMs !== null ? `${s.rttMs} ms` : '—'
    this.el.snaps.textContent = s.snapsPerSec > 0 ? String(s.snapsPerSec) : '—'
  }

  /** Per-frame countdowns (death timer on the server clock, end timer local). */
  tick(serverNowMs: number): void {
    if (this.deathActive && !this.deathReady) {
      const remain = Math.max(0, this.respawnAtMs - serverNowMs)
      if (remain > 0) {
        this.el.deathCount.textContent = String(Math.ceil(remain / 1000))
      } else {
        this.deathReady = true
        this.el.deathCount.textContent = 'ГОТОВ'
        this.el.deathCards.classList.remove('hidden')
        this.el.respawn.classList.remove('hidden')
      }
    }
    if (this.endActive) {
      const remain = Math.max(0, this.endUntilMs - Date.now())
      this.el.endCount.textContent = String(Math.ceil(remain / 1000))
      // CRT-рестарт (плейтест «выключение экрана белый шум сжимается в
      // точку… а потом бац»): за ~0.9 с до конца отрисовываем выключение —
      // «бац» попадает ровно на старт нового матча
      if (remain <= 900 && this.onCrtOff !== null) {
        const cb = this.onCrtOff
        this.onCrtOff = null // один раз
        cb()
      }
      if (remain <= 0) this.hideEnd()
    }
  }

  /** CRT-выключение перед рестартом (§16.6 end-анимация), ставит main.ts. */
  onCrtOff: (() => void) | null = null
}
