// HackStrike client — M1 FPS core.
//
// main.ts is glue only: net.ts feeds parsed messages in, the frame loop
// interpolates snapshots ~100 ms in the past (no client prediction, GDD §9.1)
// and drives camera / remote players / auto-fire / HUD / minimap. The server
// is the single source of truth for positions, HP, damage and score.

import { Engine } from '@babylonjs/core/Engines/engine'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'

import { GameSocket } from './net'
import type { Cls, ServerMessage, SnapPlayer } from './net'
import { startUpdateWatch } from './updatewatch'
import { createScene } from './scene'
import { fetchMap, MapWorld } from './map'
import {
  EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PlayerViews,
  SnapshotBuffer,
} from './players'
import { Controls } from './controls'
import { AutoFire, Effects, Scope, type TargetBox } from './combat'
import { Hud } from './hud'
import { Minimap } from './minimap'
import type { MiniCyberDev } from './minimap'
import { PropsView } from './props'
import { HackView } from './hackview'
import { CLASS_BY_KEY } from './classes'
import { IS_TOUCH, TouchOverlay, startKeyboardTracker, enterLandscapeFullscreen, exitLandscapeFullscreen } from './mobile'

// 66 мс (было 100; ×1.5 ревебр owner 2026-11-17, ГДД §15.13): тап-движение
// на мобиле. Серверная lag-compensation синхронизирована — rewindTicks=3.
const RENDER_DELAY_MS = 66
const INPUT_INTERVAL_MS = 1000 / 30
const KILLFEED_ATTRIBUTION_MS = 3000
const SNIPER_FOV_COS = Math.cos((25 * Math.PI) / 180) // конус «в поле зрения» для авто-зума
const SNIPER_ZOOM_RANGE = 35 // дальше — зум не включается (м)

type SnapMsg = Extract<ServerMessage, { t: 'snap' }>
type ShotMsg = Extract<ServerMessage, { t: 'shot' }>
type DeathMsg = Extract<ServerMessage, { t: 'death' }>
type EnvKillMsg = Extract<ServerMessage, { t: 'envkill' }>
type EndMsg = Extract<ServerMessage, { t: 'matchend' }>
type JackinMsg = Extract<ServerMessage, { t: 'jackin' }>

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement
// preserveDrawingBuffer — чтобы canvas можно было снимать в картинку
// (скриншот meatview для invite-заставки, §15.5).
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true })
const { scene, camera } = createScene(engine)

const hud = new Hud()
const controls = new Controls(canvas)

// Touch-оверлей meatview (ГДД §15.1) — только при детекте пальца: крестина
// движения слева, круг прицела справа, ДЕЙСТВИЕ=Space. --kb для деки (§15.2).
let touch: TouchOverlay | null = null
// FPS-чип вместо debug-панели на тапе (ГДД §15.9): #debug скрыт CSS, а лёгкая
// телеметрия кадра остаётся. Пишется раз в секунду — дешевле каждого кадра.
const fpsChip = IS_TOUCH ? document.getElementById('fpsChip') : null
let lastFpsAt = 0
if (IS_TOUCH) {
  document.body.classList.add('touch')
  startKeyboardTracker()
  touch = new TouchOverlay(controls)
}
const views = new PlayerViews(scene)
const buffer = new SnapshotBuffer()
const autofire = new AutoFire()
const scope = new Scope(camera.fov, camera)
const effects = new Effects(scene)

let world: MapWorld | null = null
let minimap: Minimap | null = null
let propsView: PropsView | null = null
// §12.1 «дорогой вход»: последний jackprog (2 Гц); at — штамп свежести,
// протухает без апдейта (сервер молчит при отмене канала).
let jackChannel: { dev: string; s: number; at: number } | null = null
// Не-хакер жмёт «действие» у устройства: красная вспышка тултипа до этого штампа
let jackErrorUntil = 0
let prevInteractUi = 0
// §16.7: клавиатура d3 — оверлей ввода кода (space у запертой двери).
let codePad: { dev: string; kp: string; wrap: HTMLElement; status: HTMLElement; showResult: (ok: boolean, match?: number) => void } | null = null

/** §16.7: клавиатура d3 — пад из 10 кнопок (как настоящий кодовый замок).
 *  Под pointer-lock фокус полю ввода не отдашь, поэтому ввод слушает window:
 *  цифры/Backspace/Enter/Esc, пока пад открыт; кнопки кликаются и тапаются.
 *  Ответ сервера `code` рисует ОК/НЕВЕРНО + «N/4 цифр на месте» — подсказка:
 *  N цифр из 4 стоят на СВОИХ местах (Fallout-style). */
function openCodePad(dev: string, kp: string): void {
  if (codePad !== null) return
  const wrap = document.createElement('div')
  wrap.className = 'codepad'
  const title = document.createElement('div')
  title.className = 'codepad-title'
  title.textContent = `ЗАМОК ${dev.toUpperCase()}`
  const x = document.createElement('button')
  x.className = 'codepad-x'
  x.textContent = '×'
  x.addEventListener('click', () => close())
  const disp = document.createElement('div')
  disp.className = 'codepad-display'
  const status = document.createElement('div')
  status.className = 'codepad-status'
  status.textContent = 'ЦИФРЫ ИЛИ КЛИК · ENTER — ВВОД · ESC — ЗАКРЫТЬ'
  const grid = document.createElement('div')
  grid.className = 'codepad-grid'
  let digits = ''
  const draw = (): void => {
    const t = digits.padEnd(4, '·')
    disp.textContent = `${t[0]} ${t[1]} ${t[2]} ${t[3]}`
  }
  const close = (): void => {
    window.removeEventListener('keydown', onKey, true)
    wrap.remove()
    codePad = null
    // вернуть пиксельный захват мыши — пад был модальным окном над игрой
    canvas.requestPointerLock?.()
  }
  // под pointer-lock Esc выходит из захвата и до страницы не доходит —
  // отпускаем lock на время пада, чтобы Esc/×/клики работали честно
  document.exitPointerLock?.()
  const submit = (): void => {
    if (digits.length !== 4) {
      status.textContent = 'НУЖНО 4 ЦИФРЫ'
      status.className = 'codepad-status bad'
      return
    }
    sock.send({ t: 'enter', dev: kp, code: digits } as never)
    digits = ''
    draw()
    status.textContent = 'ПРОВЕРКА…'
    status.className = 'codepad-status'
    // сторожевой таймаут: ответ потерялся — не вешаем панель навсегда
    window.setTimeout(() => {
      if (codePad !== null && codePad.dev === dev && status.textContent === 'ПРОВЕРКА…') {
        status.textContent = 'НЕТ ОТВЕТА — ПОВТОРИ'
        status.className = 'codepad-status bad'
      }
    }, 3000)
  }
  const press = (k: string): void => {
    if (k === 'C') {
      digits = ''
      draw()
      status.textContent = 'СБРОС'
      status.className = 'codepad-status'
      return
    }
    if (k === '⌫') {
      digits = digits.slice(0, -1)
      draw()
      return
    }
    if (k === 'ОТКРЫТЬ') {
      submit()
      return
    }
    if (digits.length >= 4) return
    digits += k
    draw()
    if (digits.length === 4) submit() // как у настоящего замка: 4-я цифра = ввод
  }
  const onKey = (e: KeyboardEvent): void => {
    if (codePad === null) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    const k = /^\d$/.test(e.key) ? e.key : e.key === 'Backspace' ? '⌫' : e.key === 'Enter' ? 'ОТКРЫТЬ' : e.key === 'Delete' ? 'C' : null
    if (k === null) return
    e.preventDefault()
    e.stopPropagation() // цифры не уходят в хоткеи деки/игру
    if (digits.length === 5) digits = digits.slice(0, 4) // защита от гонки submit
    press(k)
  }
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫', 'ОТКРЫТЬ']) {
    const b = document.createElement('button')
    b.className = 'codepad-key' + (k === 'ОТКРЫТЬ' ? ' ok' : k === 'C' || k === '⌫' ? ' clr' : '')
    b.textContent = k
    b.addEventListener('click', () => press(k))
    grid.append(b)
  }
  const head = document.createElement('div')
  head.className = 'codepad-head'
  head.append(title, x)
  wrap.append(head, disp, grid, status)
  document.body.append(wrap)
  draw()
  window.addEventListener('keydown', onKey, true)
  codePad = {
    dev,
    kp,
    wrap,
    status,
    showResult: (ok, match) => {
      if (ok) {
        status.textContent = 'ОТКРЫТО ✓'
        status.className = 'codepad-status ok'
        window.setTimeout(() => {
          if (codePad !== null && codePad.dev === dev) close()
        }, 900)
      } else {
        status.textContent = `НЕВЕРНО — ${match ?? 0}/4 ЦИФР НА МЕСТЕ`
        status.className = 'codepad-status bad'
        digits = ''
        draw()
      }
    },
  }
}

let myId: number | null = null
let myTeam = -1
let myCls: Cls = 'assault'
let playing = false // welcome received (join accepted)
let matchOver = false
let lastTimeLeft = Number.POSITIVE_INFINITY

let latestMeta = new Map<number, SnapPlayer>()
/** Устройства, раскрытые МОИМ portscan'ом (M3 §13.8: кибер-слой миникарты;
 *  персистентны между джек-инами, как devices в hackview — ГДД §12.1). */
let scanDevs = new Map<string, MiniCyberDev>()
let cyberMapOn = true // кибер-слой миникарты: по умолчанию ВКЛ у хакера (§13.8)
const prevAlive = new Map<number, boolean>()
const lastHits = new Map<number, { by: number; at: number }>()
const debugShots: ShotMsg[] = [] // ring buffer behind window.__hs for e2e probes
let lastMyHp = -1
/** Смерть от среды (M4 §14.3): envkill(broadcast) рисует киллфид «ЛОВУШКА» и
 *  ставит штамп на жертву — последующий alive→dead переход снапа того же id
 *  молча подавляется (иначе дубль/`???`). */
const envKillAt = new Map<number, number>()

function resetSession(): void {
  playing = false
  myId = null
  envKillAt.clear()
  lastMyHp = -1
  buffer.clear()
  views.clear()
  latestMeta = new Map()
  scanDevs = new Map()
  prevAlive.clear()
  lastHits.clear()
  matchOver = false
  hud.setWeapon(null)
  autofire.reset()
  scope.reset()
  hackviewOff(false)
  hackview.setMyId(null)
  hud.hideEnd()
  hud.hideDeath()
  hud.crosshairLocked(false)
  hud.scope(false)
  hud.jackinHint(null)
  exitLandscapeFullscreen() // возврат в лобби — снимаем принудительный ландшафт/fullscreen (§15.4)
}

function handleShot(msg: ShotMsg): void {
  const to = new Vector3(...msg.to)
  if (msg.by === myId) {
    // Own tracer starts at the bottom of the screen (muzzle), not at the eye.
    const fwd = camera.getDirection(Vector3.Forward())
    const right = camera.getDirection(Vector3.Right())
    const muzzle = camera.position
      .add(fwd.scale(0.45))
      .add(right.scale(0.16))
      .add(new Vector3(0, -0.22, 0))
    effects.tracer(muzzle, to, myTeam, true)
  } else {
    const shooter = latestMeta.get(msg.by)
    effects.tracer(new Vector3(...msg.from), to, shooter?.team ?? 0, false)
  }
  if (msg.hit > 0) {
    const victim = latestMeta.get(msg.hit)
    effects.flash(to, victim?.team ?? 0)
    if (msg.by === myId) hud.hitmarker()
    lastHits.set(msg.hit, { by: msg.by, at: performance.now() })
    if (lastHits.size > 64) {
      const oldest = lastHits.keys().next().value
      if (typeof oldest === 'number') lastHits.delete(oldest)
    }
  }
}

function handleSnap(snap: SnapMsg): void {
  buffer.push(snap)
  latestMeta = new Map(snap.players.map((p): [number, SnapPlayer] => [p.id, p]))
  // M2: живое состояние пропсов (двери/кабели) — всем, толерантно к пустому списку
  if (snap.props.length > 0) {
    propsView?.updateFromSnap(snap.props)
    hackview.updateProps(snap.props)
  }
  // §13.7: LED камерам нужен контекст «свой/чужой» — он живёт в ростере.
  propsView?.setOwnerState(
    myId !== null
      ? (owner) => (owner === myId || latestMeta.get(owner)?.team === myTeam ? 'own' : 'foe')
      : null,
  )
  hud.setRoster(snap.players, myId)
  const me = myId !== null ? latestMeta.get(myId) : undefined
  // Самоисцеление десинка (плейтест M2-2): сервер считает нас джекнутыми, а
  // дека не показана — ESC в таком состоянии мёртв (гейт hackview.active),
  // игрок навечно стоял бы у терминала. Шлём jackout сами.
  if (me !== undefined && me.jacked && !hackview.active) {
    console.warn('[hs] desync: server jacked, deck closed — auto jackout')
    sock.sendJackout()
  }
  if (me !== undefined) {
    if (lastMyHp > me.hp) hud.damageFlash()
    lastMyHp = me.hp
  }
  if (me !== undefined) {
    if (me.cls !== myCls) myCls = me.cls // сервер скорректировал класс
    hud.setWeapon(myCls === 'hacker' ? 'ПИСТОЛЕТ' : null)
  }
  hud.setVitals(me !== undefined ? me.hp : 0, CLASS_BY_KEY[myCls].hp, CLASS_BY_KEY[myCls].label)
  hud.setScores(snap.scores, snap.timeLeft / 1000) // hud expects seconds, wire has ms

  // Killfeed from observed alive→dead transitions, attributed to the most
  // recent shot with a hit (raw shot spam at 8-12 shots/s would flood it).
  for (const p of snap.players) {
    const prev = prevAlive.get(p.id)
    if (prev === true && !p.alive) {
      const env = envKillAt.get(p.id)
      if (env !== undefined && performance.now() - env <= KILLFEED_ATTRIBUTION_MS) {
        envKillAt.delete(p.id) // киллфид «ЛОВУШКА» уже выведен по envkill
      } else {
        const hit = lastHits.get(p.id)
        const fresh = hit !== undefined && performance.now() - hit.at <= KILLFEED_ATTRIBUTION_MS
        const killerId = fresh ? hit.by : -1
        const killer = killerId >= 0 ? latestMeta.get(killerId)?.name ?? `player_${killerId}` : '???'
        const killerTeam = killerId >= 0 ? latestMeta.get(killerId)?.team ?? 0 : 0
        hud.killfeed(killer, killerTeam, p.name, p.team)
      }
    }
    prevAlive.set(p.id, p.alive)
  }
  for (const id of [...prevAlive.keys()]) {
    if (!latestMeta.has(id)) prevAlive.delete(id)
  }
  const now = performance.now()
  for (const [id, at] of envKillAt) if (now - at > KILLFEED_ATTRIBUTION_MS) envKillAt.delete(id)

  // Respawn confirmed by the server → drop the death overlay.
  if (me?.alive === true) hud.hideDeath()

  // Timer jumped up → the server restarted the match while the end overlay
  // was showing its 10s countdown.
  if (matchOver && snap.timeLeft > lastTimeLeft + 1) hud.hideEnd()
  lastTimeLeft = snap.timeLeft
}

function handleEnvKill(msg: EnvKillMsg): void {
  // §14.3: broadcast убийства средой. Владелец (trojan) ≠ жертва → обычная
  // строка «ВЛАДЕЛЕЦ ▸ жертва» (сервер уже начислил +1); без владельца →
  // «ЛОВУШКА». Штамп подавляет переходной дубль в handleSnap; оверлей жертве
  // рисует приватный death by:0 (там всегда «ЛОВУШКА» — владелец мог умереть).
  envKillAt.set(msg.victim, performance.now())
  const v = latestMeta.get(msg.victim)
  if (!v) return
  const o = msg.owner > 0 && msg.owner !== msg.victim ? latestMeta.get(msg.owner) : undefined
  if (o) hud.killfeed(o.name, o.team, v.name, v.team)
  else hud.killfeedEnv(v.name, v.team)
}

function handleDeath(msg: DeathMsg): void {
  // by=0 — среда/ловушка (M4 §14.3): убийства нет в счётчике, имя стрелявшего
  // не подставляем (киллфид рисует envkill). Отсутствующее by (parse → -1) —
  // старое поведение '???'.
  if (msg.by === 0) {
    hud.showDeath('ЛОВУШКА', msg.respawnAt, myCls)
  } else {
    const killer = msg.by >= 0 ? latestMeta.get(msg.by)?.name ?? `player_${msg.by}` : '???'
    hud.showDeath(killer, msg.respawnAt, myCls)
  }
  autofire.reset()
  hackviewOff(false) // сервер джек-аутит сам; оверлей гасим сразу (ГДД §12.1)
  touch?.reset() // мёртвое тело не должно «бежать» через удержанную крестину (§15.1)
}

function handleEnd(msg: EndMsg): void {
  matchOver = true
  hackviewOff(false)
  hud.showEnd(msg.winner, msg.scores, () => {
    matchOver = false
  })
}

const sock = new GameSocket({
  onStats: (s) => hud.stats(s),
  onMessage: (msg) => {
    switch (msg.t) {
      case 'welcome':
        myId = msg.id
        myTeam = msg.team
        playing = true
        buffer.clear()
        views.clear()
        hackview.setMyId(msg.id)
        hud.setTeam(msg.team)
        hud.hideJoin()
        break
      case 'team':
        myTeam = msg.team
        hud.setTeam(msg.team)
        break
      case 'snap':
        handleSnap(msg)
        break
      case 'shot':
        debugShots.push(msg)
        if (debugShots.length > 20) debugShots.shift()
        handleShot(msg)
        break
      case 'death':
        handleDeath(msg)
        break
      case 'envkill':
        handleEnvKill(msg)
        break
      case 'matchend':
        handleEnd(msg)
        break
      case 'jackin':
        hackviewOn(msg)
        jackChannel = null // канал установлен — подсказку прогресса гасим
        break
      case 'jackprog':
        // §12.1 «дорогой вход»: прогресс установки канала (2 Гц).
        jackChannel = { dev: msg.dev, s: msg.s, at: performance.now() }
        break
      case 'deck':
        hackview.onDeck(msg)
        break
      case 'scan':
        hackview.onScan(msg)
        // Кибер-миникарта (§13.8): те же знания, что у деки; scan — полный
        // срез, заменяем карту целиком (как this.devices в hackview).
        scanDevs = new Map(
          msg.devices.map((d): [string, MiniCyberDev] => [
            d.id,
            {
              id: d.id,
              x: d.x,
              z: d.z,
              kind: d.kind === 'cable' ? 'switch' : d.kind,
              owner: d.owner,
              links: d.links,
              vulned: d.vulned,
              watched: d.watched,
              firewalled: d.firewalled,
              firewalledBy: d.firewalledBy,
              antivirused: d.antivirused,
            },
          ]),
        )
        break
      case 'code': {
        // §16.7: итог ввода кода на клавиатуре d3; match=-1 — анти-флуд.
        if (codePad !== null && msg.dev === codePad.dev) {
          if (msg.match === -1) {
            codePad.status.textContent = 'СЛИШКОМ ЧАСТО — ПОДОЖДИ 2 С'
            codePad.status.className = 'codepad-status bad'
          } else {
            codePad.showResult(msg.ok, msg.match)
          }
        }
        break
      }
      case 'denied':
        // §16.7: отказ ввода кода (too_far и пр.) — в пад, а не в никуда.
        if (codePad !== null && msg.prog === 'enter') {
          codePad.status.textContent = msg.reason === 'too_far' ? 'СЛИШКОМ ДАЛЕКО ОТ КЛАВИАТУРЫ' : `ОТКАЗ: ${msg.reason}`
          codePad.status.className = 'codepad-status bad'
          break
        }
        // enemy_team (§12.5, ред. 2026-11-17) приходит ДО джек-ина — деки ещё
        // нет, hackview.onDenied молчит; предупреждение — на HUD.
        if (msg.reason === 'enemy_team') {
          const dev = msg.dev !== undefined ? ` (${msg.dev.toUpperCase()})` : ''
          hud.warn(`УСТРОЙСТВО ЗАХВАЧЕНО ДРУГОЙ КОМАНДОЙ${dev}`)
        }
        hackview.onDenied(msg)
        break
      case 'alert': {
        // Сработал триггер (M3 §13.2): watcher — чужой вход/установка/смена
        // владельца (§13.1); firewall — чужой portscan упёрся в мой фильтр
        // (§13.5); antivirus — отбита попытка trojan (§13.6). relay — дубль
        // союзнику хозяина watcher'а (§13.1 №4): понятная строка, не «W ▸».
        // В деке-WM — тост, иначе — HUD.
        const whoName = latestMeta.get(msg.who)?.name ?? `player_${msg.who}`
        const dev = msg.dev.toUpperCase()
        let text: string
        if (msg.relay === true) {
          const evText =
            msg.ev === 'install'
              ? `УСТАНОВКА ${(msg.prog ?? '').toUpperCase()}`
              : msg.ev === 'owner'
                ? 'СМЕНА ВЛАДЕЛЬЦА'
                : 'ДЖЕК-ИН'
          text = `WATCHER: ${dev} ← ${whoName} · ${evText}`
        } else if (msg.src === 'firewall') {
          text = `F ▸ ${dev} ← ${whoName}`
        } else if (msg.src === 'antivirus') {
          text = `A ▸ ${dev} ← ${whoName}`
        } else {
          // Хозяин watcher'а: хакерская строка с контекстом события.
          text = `W ▸ ${dev} ← ${whoName}`
          if (msg.ev === 'install') text += ` ▸ УСТАНОВКА ${(msg.prog ?? '').toUpperCase()}`
          else if (msg.ev === 'owner') text += ` ▸ ВЛАДЕЛЕЦ`
        }
        if (hackview.active) hackview.onAlert(text)
        else hud.alert(text)
        break
      }
      case 'cam':
        // Лента камеры (M3 §13.7): только моей — сервер фильтрует; храним и
        // вне hackview (открыв таб, увиим последний кадр).
        hackview.onCam(msg)
        break
      case 'radar':
        // Радар-срез watcher'а (M3 §13.1 №3): только мой — сервер фильтрует;
        // храним и вне hackview (открыв таб устройства, вижу срез сразу).
        hackview.onRadar(msg)
        break
      case 'pong':
        break // RTT is tracked inside the socket
      default:
        break
    }
  },
  onClose: resetSession,
})
sock.start() // connect + stats window; without this join has no socket to ride on

// Hacker view (M2, ГДД §12.6). Джек-ин делает сервер по interact-клавишу;
// выход — CTRL/CMD+ALT+DEL (перехват ниже) или смерть (сервер сам джек-аутит).
const hackview = new HackView({
  send: (m) => sock.send(m),
  teamOf: (playerId) => latestMeta.get(playerId)?.team ?? null,
  // Имя по id для журнала событий watcher'а (§13.1 №1): те же метаданные
  // снапа, что и для whoName в роутинге alert.
  nameOf: (playerId) => latestMeta.get(playerId)?.name ?? null,
  // Тап-джек-аут на touch (ГДД §15.2): кнопка ВЫХОД в шапке дека.
  jackout: () => {
    sock.sendJackout()
    hackviewOff(true)
  },
})

function hackviewOn(msg: JackinMsg): void {
  hackview.activate(msg, propsView?.hostKind(msg.host) ?? null)
  document.body.classList.add('hackmode') // прячет FPS-HUD (CSS)
  controls.frozen = true // взгляд и клавиши не меняют состояние тела
  controls.resetKeys()
  touch?.reset() // крестина/прицел скрыты CSS — не оставляем «удержание» (§15.1)
  // Курсор нужен для кликов по WM (карта сети, кнопки); upon jackout
  // pointer lock запрашивается снова из keydown-жеста.
  if (document.pointerLockElement !== null) document.exitPointerLock()
}

function hackviewOff(relock: boolean): void {
  if (!hackview.active) return
  hackview.deactivate()
  document.body.classList.remove('hackmode')
  controls.frozen = false
  controls.resetKeys()
  touch?.reset()
  if (relock && playing) controls.requestLock()
}

// Джек-аут из деки — ТОЛЬКО тройка Ctrl/Cmd+Alt+Del (фишка: специально
// неудобно, «системный» жест, решение владельца 2026-11-15). ESC/Backspace
// принадлежат деке (палитра, меню). NB: на Windows Ctrl+Alt+Del перехватывается
// ОС и до страницы не доходит. На mac клавиша «Delete» физически = Backspace
// (e.code 'Backspace'), forward-Delete только с Fn — принимаем оба кода,
// иначе тройка Cmd+Alt+Delete на mac-ноутбуке не работает (плейтест M3).
window.addEventListener(
  'keydown',
  (e) => {
    if (!hackview.active) return
    const del = e.code === 'Delete' || e.code === 'Backspace'
    if (del && e.altKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      sock.sendJackout()
      hackviewOff(true)
    }
  },
  { capture: true },
)

// Кибер-слой миникарты (M3 §13.8): тогл клавишей C, только хакер. Слой
// знания (scanDevs) копится у любого игрока, но рисуется лишь хакеру.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyC' || e.repeat) return
  if (e.target instanceof HTMLElement && e.target.closest('button, input, .card, .chk, .segBtn') !== null) return
  if (playing && myCls === 'hacker') cyberMapOn = !cyberMapOn
})

hud.onSensScale = (k) => {
  controls.sensScale = Math.max(0.3, Math.min(4, k))
}
hud.reapplySens() // конструктор Hud отработал до этой строки — применяем заново (§15.5)
hud.onJoin = (name, cls, team) => {
  myCls = cls
  controls.invertY = hud.invertYOn // settings checkbox on the join screen
  sock.join(name, cls, team)
  // The deploy click is a user gesture: grab the mouse right away, no extra
  // "click to lock" step.
  controls.requestLock()
  // Touch: тот же жест разворачивает на весь экран и принудит ландшафт (§15.4)
  if (IS_TOUCH) enterLandscapeFullscreen()
}
hud.onRespawn = (cls) => {
  myCls = cls
  sock.sendRespawn(cls)
  controls.requestLock()
}

// Relock on any input after the lock was lost (Esc, tab switch). Chrome
// rejects immediate relock for ~1.2s after an Esc exit; the request is
// silently dropped and the next mousedown/keydown picks it up.
// NB: never grab the pointer from UI controls (respawn button, class cards):
// engaging pointer-lock mid-gesture makes Chrome swallow the button's click
// event, so the respawn overlay would never close on mouse click.
// NB: tc-* (стик/прицел/ДЕЙСТВИЕ) — тоже UI: короткий тап по ним не должен
// открывать меню паузы, иначе «палец лёг и оторвался» замораживает игрока
// frozen-меню посреди движения (баг-фикс 2026-11-17, ГДД §15.12).
// NB: #topbar — UI с §15.15: он ОТКРЫВАЕТ меню своим click-обработчиком;
// в isUiTarget он стоит, чтобы tryRelock не тянул pointer-lock в тот же
// mousedown (гонка requestPointerLock↔exitPointerLock на десктопе).
const isUiTarget = (e: Event): boolean =>
  e.target instanceof HTMLElement &&
  e.target.closest('button, input, .card, .chk, .segBtn, .tc-pad, .tc-look, .tc-act, #topbar') !== null
const tryRelock = (e: Event) => {
  // Меню паузы открыто — курсор нужен для выбора команды/класса; никакой
  // перекламки указателя (иначе любой keydown в меню возвращает mlook).
  if (menuOpen) return
  if (isUiTarget(e)) return
  // В hacker view курсор нужен для кликов по WM — не захватываем его обратно.
  if (playing && !hackview.active && !controls.locked) controls.requestLock()
}
document.addEventListener('mousedown', tryRelock)
document.addEventListener('keydown', tryRelock)

// Меню паузы (§15.5, ред. §15.15): ОТКРЫТИЕ — только тап/клик по табло счёта
// (#topbar, верх-центр) или «~» на десктопе. Тап/клик по экрану больше не
// открывает: с аналоговым стиком (§15.11) коротких касаний слишком много,
// экран «ВЕРНУТЬСЯ В БОЙ» всплывал от мискликов (ревебр owner). Закрытие —
// «~», кнопка «ВЕРНУТЬСЯ В БОЙ» или тап по фону открытого меню. Стрельбе не
// мешает: она авто (AutoFire), mousedown свободен. Пока меню открыто —
// controls.frozen (тело не бегает).
let menuOpen = false
function gameMenu(open: boolean): void {
  if (open === menuOpen) return
  menuOpen = open
  if (open) {
    hud.showMenu()
    controls.resetKeys()
    controls.frozen = true
    if (document.pointerLockElement !== null) document.exitPointerLock()
  } else {
    hud.hideMenu()
    controls.frozen = false
    controls.resetKeys()
    if (playing && !hackview.active) controls.requestLock()
  }
}
hud.onResume = () => {
  if (menuOpen) gameMenu(false)
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Backquote' || e.repeat || IS_TOUCH) return
  if (e.target instanceof HTMLElement && e.target.closest('input') !== null) return
  if (!playing) return
  gameMenu(!menuOpen)
})
// Клик по фону открытого меню — закрыть (§15.12: тогл симметричен «~»);
// клики внутри .panel/модалок — их дела. ОТКРЫТИЕ кликом по экрану убрано
// (§15.15): с автоогнём и аналоговым стиком случайный клик/тап открывал
// «ВЕРНУТЬСЯ В БОЙ» слишком часто — теперь меню открывает только тап/клик по
// табло счёта (#topbar) или «~» на десктопе.
document.addEventListener('mousedown', (e) => {
  // Compat-мышь после тача (~300 мс) не в счёт: touchend уже решил, иначе
  // тап-тогл открывал бы меню и сразу сам закрывал (§15.12).
  if (performance.now() - lastTouchAt < 700) return
  // Табло — не «фон»: его тоглит свой click-хендлер ниже, иначе mousedown
  // закрыл бы меню, а click тут же открыл бы заново.
  if (e.target instanceof HTMLElement && e.target.closest('#topbar') !== null) return
  if (menuOpen) {
    if (e.target instanceof HTMLElement && e.target.closest('.panel, .settings') === null) gameMenu(false)
  }
})
// §15.15: табло счёта — кнопка меню (тап на мобиле, клик при разблокированном
// курсоре на десктопе; под pointer lock DOM-кликов нет — там «~»). click, а не
// pointerdown: на iOS тач даёт click сам, синтетический — после touchend, а
// touchend-хендлер ниже по isUiTarget(#topbar) молчит.
document.getElementById('topbar')?.addEventListener('click', () => {
  if (performance.now() - lastTouchAt < 700) return // решит touch-путь/следующий клик
  if (!playing || hud.deathVisible() || hackview.active) return
  gameMenu(!menuOpen)
})
// Тап (короткий, без движения) по игровому экрану на мобиле — то же самое.
// compat-мышь после тача глушим по времени: touchend уже отработал тогл,
// synthetic mousedown не должен тут же закрыть/переоткрыть меню (§15.12).
let lastTouchAt = 0
let tapStart: { x: number; y: number; t: number } | null = null
document.addEventListener(
  'touchstart',
  (e) => {
    lastTouchAt = performance.now()
    if (e.touches.length === 1) {
      const t = e.touches[0]
      tapStart = { x: t.clientX, y: t.clientY, t: performance.now() }
    } else tapStart = null
  },
  { capture: true },
)
document.addEventListener(
  'touchend',
  (e) => {
    if (tapStart === null || e.changedTouches.length !== 1) return
    const t = e.changedTouches[0]
    const moved = Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y)
    const dt = performance.now() - tapStart.t
    tapStart = null
    if (moved > 12 || dt > 350) return // это был look-жест, не тап
    // §15.15: тап по табло счёта — открыть/закрыть меню (единственный жест-
    // вход; экран больше не тапается). Синтетический click после touchend
    // гасится lastTouchAt-гейтом, двойного тогла нет.
    if (e.target instanceof HTMLElement && e.target.closest('#topbar') !== null) {
      if (playing && !hud.deathVisible() && !hackview.active) gameMenu(!menuOpen)
      return
    }
    if (isUiTarget(e)) return
    // Тап по фону открытого меню — закрыть (§15.12); внутри панели — её дела.
    if (menuOpen) {
      if (e.target instanceof HTMLElement && e.target.closest('.panel, .settings') === null) gameMenu(false)
    }
  },
  { capture: true },
)

// Map geometry comes only from the server (GDD invariant: карта — данные).
hud.showJoin()
hud.setMapStatus('ЗАГРУЗКА КАРТЫ…')
void fetchMap((attempt) => hud.setMapStatus(`КАРТА НЕДОСТУПНА (ПОПЫТКА ${attempt})…`)).then(
  (map) => {
    world = MapWorld.build(scene, map)
    propsView = PropsView.build(scene, map) // M2: терминалы/радио/switch/двери/кабели
    // §16.7: space у клавиатуры замка = пад кода (перехват ДО отправки на
    // сервер — иначе тот же space уходил бы в джек-ин). Позиция — камера
    // (рендер-луп держит её в интерполированной позе моего тела).
    {
      const pv = propsView
      controls.interactInterceptor = () => {
        if (codePad !== null || !playing || hackview.active) return false
        const kp = pv.nearestKeypad(camera.position.x, camera.position.z, camera.position.y - EYE_HEIGHT)
        if (kp === null || kp.dist > 2) return false
        openCodePad(kp.door, kp.id)
        return true
      }
    }
    window.__hs = window.__hs ?? undefined // noop-guard
    if (window.__hs) window.__hs.propsView = propsView
    minimap = new Minimap(document.getElementById('minimap') as HTMLCanvasElement, world)
    hud.setMapStatus(null)
    hud.hideLoading() // мир собран — гасим экран загрузки, join готов под ним
  },
)

// Pointer lock comes from the join/respawn clicks plus the relock listeners
// above; no dedicated canvas-click path is needed.

// Input stream to the server: ~30/s, latest keys + view angles. Пока хакер
// в деке — тело стоит: ни input, ни fire не отправляем (ГДД §12.1).
// Мгновенный flush при смене контрольного состояния (pointerdown/смена
// сектора/keydown-keyup) — не ждём следующего слота 30 Гц, иначе короткий
// тач-тап двигает тело уже после отпускания пальца (ГДД §15.13). Слот по
// таймеру — fallback keepalive; серверный кламп 60/с (§15.4) не страдает:
// флешей не больше одного на изменение.
let lastInputSentAt = 0
function sendInputNow(): void {
  if (!playing || hackview.active) return
  lastInputSentAt = performance.now()
  // Touch ДЕЙСТВИЕ — edge как у Space: 1 в ближайший тик (сервер видит rising
  // edge interact); controls.keys.interact при этом остаётся 0 (§15.1).
  if (touch !== null) controls.keys.interact = touch.consumeInteract()
  sock.sendInput(controls.keys, controls.yaw, controls.pitch)
}
window.setInterval(() => {
  if (performance.now() - lastInputSentAt >= INPUT_INTERVAL_MS / 2) sendInputNow()
}, INPUT_INTERVAL_MS)
controls.onActivity = sendInputNow
if (touch !== null) touch.onActivity = sendInputNow

engine.runRenderLoop(() => {
  const nowSec = performance.now() / 1000
  const serverNow = buffer.serverNow()
  const states = buffer.playersAt(serverNow - RENDER_DELAY_MS)

  // Own body is never rendered; the camera rides the interpolated snapshot.
  const me = myId !== null ? states.get(myId) : undefined
  if (me !== undefined) camera.position.set(me.x, me.y + EYE_HEIGHT, me.z)
  // Babylon's rotation.x is positive-DOWN; the wire pitch is positive-UP
  // (GDD §9.2) — negate or every shot sent to the server aims mirrored.
  camera.rotation.x = -controls.pitch
  camera.rotation.y = controls.yaw

  views.sync(states, myId)

  // Анимация дверей пропсов: шаг по реальному кадру (клэмп от табов в фоне).
  propsView?.tick(Math.min(0.1, engine.getDeltaTime() / 1000))

  const alive = me?.meta.alive === true

  // Подсказка джек-ина: хакер в 2 м от терминала / 8 м от радио (ГДД §12.1).
  // Ховер-метка пропса под прицелом (switch/терминал/радио/дверь).
  if (playing && alive && !hackview.active && propsView !== null) {
    const fwd = camera.getDirection(Vector3.Forward())
    hud.propLabel(propsView.propAt({ x: camera.position.x, y: camera.position.y, z: camera.position.z }, { x: fwd.x, y: fwd.y, z: fwd.z }, 24))
  } else {
    hud.propLabel(null)
  }

  let hint: string | null = null
  let hintError = false
  if (playing && alive && !matchOver && !hackview.active && propsView !== null && me !== undefined) {
    // Цель подсказки — с учётом взгляда (§15.12): вне радиуса подсказываем ту
    // точку, в которую смотрим, а не ту, что осталась за спиной.
    const hf = camera.getDirection(Vector3.Forward())
    const near = propsView.nearestJackPoint(me.x, me.z, { x: hf.x, y: hf.y, z: hf.z }, me.y)
    // Не-хакер жмёт «действие» у устройства — тултип мигает красным, чтобы
    // было видно, в чём косяк (плейтест 2026-11-17). Edge по interact покрывает
    // и SPACE, и мобильную кнопку (обе идут через controls.keys.interact).
      const it = controls.keys.interact
    // §16.7: space у клавиатуры замка перехвачен ДО отправки (interceptor,
    // см. ниже) — здесь только подсказка; у двери — обычный джек-ин.
    const kp = propsView.nearestKeypad(me.x, me.z, me.y)
    if (it === 1 && prevInteractUi === 0 && myCls !== 'hacker' && near !== null && near.dist <= 2) {
      jackErrorUntil = performance.now() + 1200
    }
    prevInteractUi = it
    const kpHint = kp !== null && kp.dist <= 2 ? kp : null
    if (kpHint !== null) {
      hint = `${IS_TOUCH ? 'ДЕЙСТВИЕ' : 'SPACE'} — КЛАВИАТУРА // ЗАМОК ${kpHint.door.toUpperCase()}`
    } else if (near !== null) {
      const label = near.label
      if (myCls !== 'hacker') {
        // «Только хакер» — вплотную (2 м), издалека подсказка не нужна
        // (плейтест M2-2), чтобы не засорять HUD чужим классом.
        if (near.dist <= 2) hint = `ДЖЕК-ИН // ${label} — ТОЛЬКО ХАКЕР`
      } else if (near.dist <= near.range) {
        hint = near.label.startsWith('ЗАМОК ')
          ? `${IS_TOUCH ? 'ДЕЙСТВИЕ' : 'SPACE'} — КЛАВИАТУРА // ${label}`
          : `${IS_TOUCH ? 'ДЕЙСТВИЕ' : 'SPACE'} — ДЖЕК-ИН // ${label}`
      } else {
        hint = `${label} — ${Math.round(near.dist)} м (РАДИУС ${Math.round(near.range)} М)`
      }
    }
  }
  if (performance.now() < jackErrorUntil && hint !== null) {
    hintError = true
  }
  // §12.1 «дорогой вход»: свежий jackprog перекрывает подсказку прогрессом
  // канала (фон строки — полоска 0..1); 1.5 с без апдейта = канал сорван,
  // показываем обычную подсказку.
  let channelProgress = -1
  if (jackChannel !== null) {
    if (performance.now() - jackChannel.at < 1500) {
      hint = `УСТАНОВКА КАНАЛА // ${jackChannel.dev.toUpperCase()} — ${Math.max(0, jackChannel.s).toFixed(1)} С`
      channelProgress = 1 - Math.max(0, jackChannel.s) / 6 // §12.1: канал 6 с
    } else {
      jackChannel = null
    }
  }
  hud.jackinHint(hint, channelProgress, hintError)

  let fired = false
  // Авто-зум снайпера: враг в конусе ~25°, ближе 20 м и в прямой видимости
  // (за стеной или через полкарты зум не включается).
  let enemyInFov = false
  if (playing && alive && myCls === 'sniper' && world !== null) {
    const fwd = camera.getDirection(Vector3.Forward())
    for (const p of states.values()) {
      if (p.id === myId || !p.meta.alive || p.meta.team === myTeam) continue
      const dx = p.x - camera.position.x
      const dy = p.y + 0.9 - camera.position.y
      const dz = p.z - camera.position.z
      const d = Math.hypot(dx, dy, dz)
      if (d > SNIPER_ZOOM_RANGE) continue
      if (d >= 1e-6) {
        if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) / d <= SNIPER_FOV_COS) continue
        if (world.rayHit(camera.position.x, camera.position.y, camera.position.z, dx / d, dy / d, dz / d, d - 0.1) !== null) continue
      }
      enemyInFov = true
      break
    }
  }
  scope.update(performance.now(), myCls, enemyInFov)
  hud.scope(scope.engaged)

  // Снайпер стреляет только в зуме, зум — сразу при появлении врага в прямой
  // видимости; выстрел — после 0.1 с удержания (ГДД §3.3). В hacker view
  // автоогонь отключён (тело беззащитно стоит у терминала).
  if (
    playing &&
    alive &&
    !matchOver &&
    !hackview.active &&
    (controls.locked || touch?.aiming === true) && // touch-гейт вместо pointer lock (§15.1)
    world !== null &&
    (myCls !== 'sniper' || scope.armed)
  ) {
    const enemies: TargetBox[] = []
    for (const p of states.values()) {
      if (p.id === myId || !p.meta.alive || p.meta.team === myTeam) continue
      enemies.push({
        min: [p.x - PLAYER_HALF_WIDTH, p.y, p.z - PLAYER_HALF_WIDTH],
        max: [p.x + PLAYER_HALF_WIDTH, p.y + PLAYER_HEIGHT, p.z + PLAYER_HALF_WIDTH],
      })
    }
    const dir = camera.getDirection(Vector3.Forward())
    // Закрытые двери — блокаторы автоогня: не цеплять врагов за ними.
    const doorBlockers = propsView?.closedDoorBoxes().map((b) => ({ min: b.min, max: b.max })) ?? []
    fired = autofire.update(nowSec, myCls, camera.position, dir, enemies, world, doorBlockers)
    if (fired) sock.sendFire(controls.yaw, controls.pitch)
  } else {
    autofire.lockedOn = false
  }
  hud.crosshairLocked(autofire.lockedOn)

  effects.update(nowSec)

  if (minimap !== null) {
    const allies: { x: number; z: number }[] = []
    for (const p of states.values()) {
      if (p.id === myId || !p.meta.alive || p.meta.team !== myTeam) continue
      allies.push({ x: p.x, z: p.z })
    }
    minimap.draw(
      me !== undefined ? { x: me.x, z: me.z, y: me.y, yaw: controls.yaw } : null,
      allies,
      myTeam,
      propsView?.miniProps() ?? [],
      cyberMapOn && myCls === 'hacker' && scanDevs.size > 0
        ? {
            myId,
            ownTeam: myTeam,
            teamOf: (id) => latestMeta.get(id)?.team ?? null,
            devices: [...scanDevs.values()],
          }
        : null,
    )
  }

  hud.tick(serverNow)
  if (fpsChip !== null && nowSec - lastFpsAt >= 1) {
    lastFpsAt = nowSec
    fpsChip.textContent = `${Math.round(engine.getFps())} FPS`
  }
  scene.render()
})

window.addEventListener('resize', () => {
  engine.resize()
})

// E2E/debug hook: browser automation can aim, fire and inspect state without
// reaching into module internals.
declare global {
  interface Window {
    __hs?: {
      controls: Controls
      sock: GameSocket
      camera: FreeCamera
      players: () => Map<number, SnapPlayer>
      shots: () => ShotMsg[]
      hackview: HackView
      propsView: PropsView | null
      doorAngle: (id: string) => number | null
      cyberMap: () => { on: boolean; devices: Map<string, MiniCyberDev> } // M3 §13.8
      updateWatch?: boolean
    }
  }
}
window.__hs = {
  controls,
  sock,
  camera,
  players: () => latestMeta,
  shots: () => [...debugShots],
  hackview,
  propsView: null, // ставится после загрузки карты
  doorAngle: (id) => propsView?.doorAngle(id) ?? null,
  cyberMap: () => ({ on: cyberMapOn && myCls === 'hacker', devices: scanDevs }),
  updateWatch: true, // auto-reload после пердеплоя (M4)
}

// M4: авто-обновление вкладки после пердеплоя клиента (см. модуль).
startUpdateWatch()
