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
import { PropsView } from './props'
import { HackView } from './hackview'
import { CLASS_BY_KEY } from './classes'

const RENDER_DELAY_MS = 100
const INPUT_INTERVAL_MS = 1000 / 30
const KILLFEED_ATTRIBUTION_MS = 3000
const SNIPER_FOV_COS = Math.cos((25 * Math.PI) / 180) // конус «в поле зрения» для авто-зума
const SNIPER_ZOOM_RANGE = 35 // дальше — зум не включается (м)

type SnapMsg = Extract<ServerMessage, { t: 'snap' }>
type ShotMsg = Extract<ServerMessage, { t: 'shot' }>
type DeathMsg = Extract<ServerMessage, { t: 'death' }>
type EndMsg = Extract<ServerMessage, { t: 'matchend' }>
type JackinMsg = Extract<ServerMessage, { t: 'jackin' }>

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement
const engine = new Engine(canvas, true)
const { scene, camera } = createScene(engine)

const hud = new Hud()
const controls = new Controls(canvas)
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
const prevAlive = new Map<number, boolean>()
const lastHits = new Map<number, { by: number; at: number }>()
const debugShots: ShotMsg[] = [] // ring buffer behind window.__hs for e2e probes
let lastMyHp = -1

function resetSession(): void {
  playing = false
  myId = null
  lastMyHp = -1
  buffer.clear()
  views.clear()
  latestMeta = new Map()
  prevAlive.clear()
  lastHits.clear()
  matchOver = false
  autofire.reset()
  scope.reset()
  hackviewOff(false)
  hackview.setMyId(null)
  hud.hideEnd()
  hud.hideDeath()
  hud.crosshairLocked(false)
  hud.scope(false)
  hud.jackinHint(null)
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
  hud.setRoster(snap.players, myId)
  const me = myId !== null ? latestMeta.get(myId) : undefined
  if (me !== undefined) {
    if (lastMyHp > me.hp) hud.damageFlash()
    lastMyHp = me.hp
  }
  if (me !== undefined) myCls = me.cls // server may have adjusted the class
  hud.setVitals(me !== undefined ? me.hp : 0, CLASS_BY_KEY[myCls].hp, CLASS_BY_KEY[myCls].label)
  hud.setScores(snap.scores, snap.timeLeft / 1000) // hud expects seconds, wire has ms

  // Killfeed from observed alive→dead transitions, attributed to the most
  // recent shot with a hit (raw shot spam at 8-12 shots/s would flood it).
  for (const p of snap.players) {
    const prev = prevAlive.get(p.id)
    if (prev === true && !p.alive) {
      const hit = lastHits.get(p.id)
      const fresh = hit !== undefined && performance.now() - hit.at <= KILLFEED_ATTRIBUTION_MS
      const killerId = fresh ? hit.by : -1
      const killer = killerId >= 0 ? latestMeta.get(killerId)?.name ?? `#${killerId}` : '???'
      const killerTeam = killerId >= 0 ? latestMeta.get(killerId)?.team ?? 0 : 0
      hud.killfeed(killer, killerTeam, p.name, p.team)
    }
    prevAlive.set(p.id, p.alive)
  }
  for (const id of [...prevAlive.keys()]) {
    if (!latestMeta.has(id)) prevAlive.delete(id)
  }

  // Respawn confirmed by the server → drop the death overlay.
  if (me?.alive === true) hud.hideDeath()

  // Timer jumped up → the server restarted the match while the end overlay
  // was showing its 10s countdown.
  if (matchOver && snap.timeLeft > lastTimeLeft + 1) hud.hideEnd()
  lastTimeLeft = snap.timeLeft
}

function handleDeath(msg: DeathMsg): void {
  const killer =
    msg.by >= 0 ? latestMeta.get(msg.by)?.name ?? `#${msg.by}` : '???'
  hud.showDeath(killer, msg.respawnAt)
  autofire.reset()
  hackviewOff(false) // сервер джек-аутит сам; оверлей гасим сразу (ГДД §12.1)
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
        break
      case 'denied':
        hackview.onDenied(msg)
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
})

function hackviewOn(msg: JackinMsg): void {
  hackview.activate(msg, propsView?.hostKind(msg.host) ?? null)
  document.body.classList.add('hackmode') // прячет FPS-HUD (CSS)
  controls.frozen = true // взгляд и клавиши не меняют состояние тела
  controls.resetKeys()
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
  if (relock && playing) controls.requestLock()
}

// Джек-аут: ESC или Backspace (любая платформа, страницы их получают), плюс
// прежний Ctrl/Cmd+Alt+Delete — NB: на Windows Ctrl+Alt+Del перехватывается
// ОС и до страницы НЕ доходит, на mac «Delete» это code Backspace.
window.addEventListener(
  'keydown',
  (e) => {
    if (!hackview.active) return
    const triple = e.code === 'Delete' && e.altKey && (e.ctrlKey || e.metaKey)
    if (e.code === 'Escape' || e.code === 'Backspace' || triple) {
      e.preventDefault()
      sock.sendJackout()
      hackviewOff(true)
    }
  },
  { capture: true },
)

hud.onJoin = (name, cls, team) => {
  myCls = cls
  controls.invertY = hud.invertYOn // settings checkbox on the join screen
  sock.join(name, cls, team)
  // The deploy click is a user gesture: grab the mouse right away, no extra
  // "click to lock" step.
  controls.requestLock()
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
  if (isUiTarget(e)) return
  // В hacker view курсор нужен для кликов по WM — не захватываем его обратно.
  if (playing && !hackview.active && !controls.locked) controls.requestLock()
}
document.addEventListener('mousedown', tryRelock)
document.addEventListener('keydown', tryRelock)

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
  },
)

// Pointer lock comes from the join/respawn clicks plus the relock listeners
// above; no dedicated canvas-click path is needed.

// Input stream to the server: ~30/s, latest keys + view angles. Пока хакер
// в деке — тело стоит: ни input, ни fire не отправляем (ГДД §12.1).
window.setInterval(() => {
  if (playing && !hackview.active) sock.sendInput(controls.keys, controls.yaw, controls.pitch)
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
  let hint: string | null = null
  if (playing && alive && myCls === 'hacker' && !hackview.active && propsView !== null && me !== undefined) {
    const near = propsView.nearestJackIn(me.x, me.z)
    if (near !== null) {
      hint = `SPACE — ДЖЕК-ИН // ${near.kind === 'radio' ? 'РАДИО-ТОЧКА' : 'ТЕРМИНАЛ'} ${near.id.toUpperCase()}`
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
    controls.locked &&
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
    fired = autofire.update(nowSec, myCls, camera.position, dir, enemies, world)
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
    )
  }

  hud.tick(serverNow)
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
}
