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

const RENDER_DELAY_MS = 100
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
      case 'denied':
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
const isUiTarget = (e: Event): boolean =>
  e.target instanceof HTMLElement && e.target.closest('button, input, .card, .chk, .segBtn') !== null
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

// Меню паузы (§15.5): в FPS-режиме клик мыши, тап по экрану или «~» открывает
// join-окно (invite/settings/вернуться). «~» — тогл; закрытие — «~», кнопка
// «ВЕРНУТЬСЯ В БОЙ» или тап по фону. Стрельбе не мешает: она авто (AutoFire),
// mousedown свободен. Пока меню открыто — controls.frozen (тело не бегает).
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
// Клик в FPS (курсор ещё захвачен) — открыть меню; мёртвым — death-оверлей,
// не меню
document.addEventListener('mousedown', () => {
  if (!hud.deathVisible() && playing && !hackview.active && controls.locked) gameMenu(true)
})
// Тап (короткий, без движения) по игровому экрану на мобиле — то же самое
let tapStart: { x: number; y: number; t: number } | null = null
document.addEventListener(
  'touchstart',
  (e) => {
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
    if (isUiTarget(e)) return
    if (!hud.deathVisible() && playing && !hackview.active && !menuOpen) gameMenu(true)
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
window.setInterval(() => {
  if (!playing || hackview.active) return
  // Touch ДЕЙСТВИЕ — edge как у Space: 1 в ближайший тик (сервер видит rising
  // edge interact); controls.keys.interact при этом остаётся 0 (§15.1).
  if (touch !== null) controls.keys.interact = touch.consumeInteract()
  sock.sendInput(controls.keys, controls.yaw, controls.pitch)
}, INPUT_INTERVAL_MS)

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
  if (playing && alive && !matchOver && !hackview.active && propsView !== null && me !== undefined) {
    const near = propsView.nearestJackPoint(me.x, me.z)
    if (near !== null) {
      const label = `${near.kind === 'radio' ? 'РАДИО-ТОЧКА' : 'ТЕРМИНАЛ'} ${near.id.toUpperCase()}`
      if (myCls !== 'hacker') {
        // «Только хакер» — вплотную (2 м), издалека подсказка не нужна
        // (плейтест M2-2), чтобы не засорять HUD чужим классом.
        if (near.dist <= 2) hint = `ДЖЕК-ИН // ${label} — ТОЛЬКО ХАКЕР`
      } else if (near.dist <= near.range) {
        hint = `${IS_TOUCH ? 'ДЕЙСТВИЕ' : 'SPACE'} — ДЖЕК-ИН // ${label}`
      } else {
        hint = `${label} — ${Math.round(near.dist)} м (РАДИУС ${Math.round(near.range)} М)`
      }
    }
  }
  hud.jackinHint(hint)

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
      me !== undefined ? { x: me.x, z: me.z, yaw: controls.yaw } : null,
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
