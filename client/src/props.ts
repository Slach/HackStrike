// M2 cyber props (GDD §12.3 / §12.6): terminals, radio points, switches,
// doors and cables + M4 gas traps (§14.2) + fire pools with water valves
// (§14.6.1, ревизия v1). Geometry is built from the map data (карта — данные),
// live state (door/gas/water-valve open) arrives via snap.props. Collisions
// are server-side — the door swing here is purely cosmetic, and the cables
// are visual only (collisions and cable cuts are server-side). Gas DoT and
// fire damage are server-side too; the client only renders states.

import { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'
import type { GameMap } from './map'
import type { MiniProp } from './minimap'
import type { CyberKind, PropKind, SnapProp } from './net'

const TERMINAL_RANGE = 2 // м, GDD §12.1
const DEFAULT_RADIO_RANGE = 8
const DOOR_SWING_S = 0.3 // GDD §12.6: ~0.3 с на открытие
const DOOR_DEFAULT_SIZE: readonly [number, number, number] = [1.6, 2.4, 0.16]
const GAS_DEFAULT_SIZE: readonly [number, number, number] = [8, 3, 8] // фолбэк для газа, приехавшего только из снапа
const GAS_TELEGRAPH_S = 1.5 // ГДД §14.2: жёлтое мигание каркаса перед первым уроном
// Цвета газа по состояниям (ГДД §14.2): тусклый объём, жёлтый телеграф, активный газ.
const GAS_FILL_IDLE = new Color3(55 / 255, 1, 155 / 255) // rgba(55,255,155) — закрытый клапан
const GAS_FILL_ACTIVE = new Color3(120 / 255, 1, 80 / 255) // rgba(120,255,80) — газ идёт
const GAS_FRAME_IDLE = new Color3(55 / 255, 1, 155 / 255)
const GAS_FRAME_TELEGRAPH = new Color3(1, 210 / 255, 55 / 255) // #ffd237 — палитровая жёлтая
const GAS_FRAME_ACTIVE = new Color3(125 / 255, 1, 80 / 255) // #7dff50
// Огонь (M4 §14.6.1, ревизия v1): урон-ландшафт с водяным контроллером.
// Горящая полоса — эмиссивный оранжевый; «кипение» — дешёвая пульсация 0.6 Гц.
// Потушенная (valve open) — тёмная, полупрозрачная, без пульсации.
const FIRE_DEFAULT_SIZE: readonly [number, number, number] = [4, 0.3, 4] // фолбэк по m1: size обязателен на сервере
const FIRE_BASE = new Color3(1, 106 / 255, 46 / 255) // #ff6a2e — базовое свечение, масштабируется пульсацией
const FIRE_PULSE_HZ = 0.6
const FIRE_OUT = new Color3(26 / 255, 35 / 255, 42 / 255) // #1a232a — потушенная полоса

export interface MapProp {
  kind: PropKind
  id: string
  pos: [number, number, number]
  radius: number
  size: [number, number, number]
  axis: 'x' | 'z'
  points: [number, number, number][]
  /** fire → id своего водяного клапана; valve → switch в сети (§14.6.1). */
  to: string | null
}

const PROP_KINDS: readonly PropKind[] = ['terminal', 'radio', 'switch', 'door', 'camera', 'cable', 'gas', 'fire', 'valve']

function tuple3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const ok = v.every((n) => typeof n === 'number' && Number.isFinite(n))
  return ok ? [v[0] as number, v[1] as number, v[2] as number] : null
}

/** Tolerant parse of map.props (GDD §12.3); invalid entries are skipped. */
function parseMapProps(raw: readonly unknown[]): MapProp[] {
  const out: MapProp[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null
    const kind = PROP_KINDS.includes(r.kind as PropKind) ? (r.kind as PropKind) : null
    // У кабеля нет pos — только points; требование pos выбрасывало их всех
    // (плейтест: «не вижу проводов»).
    const pos = tuple3(r.pos) ?? [0, 0, 0]
    if (id === null || kind === null) continue
    out.push({
      kind,
      id,
      pos,
      radius: typeof r.radius === 'number' && r.radius > 0 ? r.radius : DEFAULT_RADIO_RANGE,
      // у газа и огня свои фолбэк-размеры: карта обязана нести size (map_test),
      // но дверь-дефолт дал бы плоский блин вместо камеры и стойку вместо полосы
      size: tuple3(r.size) ?? (kind === 'gas' ? [...GAS_DEFAULT_SIZE] : kind === 'fire' ? [...FIRE_DEFAULT_SIZE] : [...DOOR_DEFAULT_SIZE]),
      axis: r.axis === 'z' ? 'z' : 'x',
      to: typeof r.to === 'string' && r.to.length > 0 ? r.to : null,
      points: Array.isArray(r.points)
        ? r.points.flatMap((p): [number, number, number][] => {
            const t = tuple3(p)
            return t !== null ? [t] : []
          })
        : [],
    })
  }
  return out
}

interface SimpleProp {
  id: string
  x: number
  z: number
  radius: number
}

interface DoorView {
  id: string
  pivot: TransformNode
  x: number
  z: number
  axis: 'x' | 'z'
  len: number
  h: number // высота полотна = ход выезда вверх
  baseY: number // базовый Y центра полотна (закрыто)
  open: boolean
  angle: number // прогресс выезда 0..1
}

interface CableView {
  id: string
  path: Vector3[]
  meshes: Mesh[]
}

/** Камера (M3 §13.7): сенсор наблюдения. LED-индикатор владения перекрашивается
 *  из snap.props.owner — нейтральная/своя/чужая видна издалека. */
interface CameraView {
  id: string
  x: number
  z: number
  led: StandardMaterial
  owner: number | null
}

/** Газ (M4 §14.2): ловушка-объём с AABB как у двери. Клиент рисует только
 *  последствия из снапа (invariant 1): закрытый клапан — тусклый каркас,
 *  телеграф — дискретное жёлтое мигание каркаса, активный газ — плотный fill.
 *  Телеграф считаем сами от момента наблюдения flip 0→1 (визуал, точность
 *  долей секунды не нужна — сервер урон тоже не синхронизирует с кадром). */
interface GasView {
  id: string
  x: number
  y: number // центр AABB — из pos пропа
  z: number
  w: number
  h: number
  d: number
  fill: Mesh
  fillMat: StandardMaterial // динамический, как LED камеры: цвет/альфа по состоянию
  frame: LinesMesh
  open: boolean
  armedAt: number // ms производительного времени последнего наблюдаемого 0→1; 0 = не было
}

/** Огонь (M4 §14.6.1, ревизия v1): урон-ландшафт, НЕ устройство — в scan/деке
 *  не появляется. Контроллер — водяной клапан: его snap-состояние open
 *  перекрашивает связанную полосу (to = id клапана из /api/map). */
interface FireView {
  id: string
  x: number
  y: number // центр AABB — из pos пропа (низ полосы стоит на плите)
  z: number
  w: number
  h: number
  d: number
  mat: StandardMaterial // эмиссив/альфа переключаются при смене состояния
  valveId: string | null
  open: boolean // true = вода идёт = полоса потушена
}

/** Водяной клапан (§14.6.1): компактный проп с трубой к потолку. Сеть и
 *  таб-управление — в hackview (CyberKind); здесь только геометрия/ховер. */
interface ValveView {
  id: string
  x: number
  z: number
  y: number
  open: boolean
}

export class PropsView {
  private readonly terminals = new Map<string, SimpleProp>()
  private readonly radios = new Map<string, SimpleProp>()
  private readonly switches = new Map<string, SimpleProp>()
  private readonly doors = new Map<string, DoorView>()
  private readonly cables = new Map<string, CableView>()
  private readonly cameras = new Map<string, CameraView>()
  private readonly gases = new Map<string, GasView>()
  private readonly fires = new Map<string, FireView>()
  private readonly valves = new Map<string, ValveView>()
  private readonly mats: Record<string, StandardMaterial>
  private miniCache: MiniProp[] = []
  /** Владелец камеры — своя команда или чужая (ставит main.ts: знает myId и
   *  ростер; null = неизвестно, LED остаётся нейтральным). */
  private ownerState: ((owner: number) => 'own' | 'foe') | null = null

  private constructor(private scene: Scene) {
    const mk = (name: string, diffuse: [number, number, number], emissive: [number, number, number]): StandardMaterial => {
      const m = new StandardMaterial(`mat.prop.${name}`, scene)
      m.diffuseColor = new Color3(...diffuse)
      m.emissiveColor = new Color3(...emissive)
      m.specularColor = Color3.Black()
      return m
    }
    const glow = (name: string, c: [number, number, number]): StandardMaterial => {
      const m = new StandardMaterial(`mat.prop.${name}`, scene)
      m.emissiveColor = new Color3(...c)
      m.disableLighting = true
      return m
    }
    this.mats = {
      body: mk('body', [0.03, 0.05, 0.04], [0.008, 0.02, 0.014]),
      screen: glow('screen', [0.05, 0.8, 0.38]),
      door: mk('door', [0.04, 0.07, 0.055], [0.01, 0.03, 0.02]),
      antenna: glow('antenna', [0.2, 0.9, 0.5]),
      led: glow('led', [0.15, 0.75, 0.42]),
      // Кабели — самосветящийся янтарь (плейтест M2-2: «не видно, как идут
      // провода»): контраст к зелёной неоновой теме, виден и у тёмного пола.
      cable: glow('cable', [0.85, 0.55, 0.1]),
      sphere: glow('sphere', [0.04, 0.3, 0.16]),
    }
    this.mats.sphere.alpha = 0.06 // тусклая сфера радиуса радио-точки, видна всем
  }

  static build(scene: Scene, map: GameMap): PropsView {
    const view = new PropsView(scene)
    for (const prop of parseMapProps(map.props)) {
      switch (prop.kind) {
        case 'terminal':
          view.buildTerminal(prop.id, prop.pos)
          break
        case 'radio':
          view.buildRadio(prop.id, prop.pos, prop.radius)
          break
        case 'switch':
          view.buildSwitch(prop.id, prop.pos)
          break
        case 'door':
          view.buildDoor(prop.id, prop.pos, prop.axis, prop.size)
          break
        case 'cable':
          view.buildCable(prop.id, prop.points)
          break
        case 'camera':
          view.buildCamera(prop.id, prop.pos)
          break
        case 'gas':
          view.buildGas(prop.id, prop.pos, prop.size)
          break
        case 'fire':
          view.buildFire(prop.id, prop.pos, prop.size, prop.to)
          break
        case 'valve':
          view.buildValve(prop.id, prop.pos)
          break
      }
    }
    view.rebuildMini()
    return view
  }

  /** Контекст владения для LED камер (main.ts знает myId и ростер). */
  setOwnerState(state: ((owner: number) => 'own' | 'foe') | null): void {
    this.ownerState = state
    for (const c of this.cameras.values()) this.tintCamera(c)
  }

  private buildTerminal(id: string, pos: readonly [number, number, number]): void {
    const body = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.55, height: 1.05, depth: 0.42 }, this.scene)
    body.position.set(pos[0], pos[1] + 0.525, pos[2])
    body.material = this.mats.body
    body.isPickable = false
    const screen = MeshBuilder.CreatePlane(
      `prop.${id}.screen`,
      { width: 0.46, height: 0.34, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    )
    screen.position.set(pos[0], pos[1] + 1.16, pos[2])
    screen.rotation.x = -0.16
    screen.material = this.mats.screen
    screen.isPickable = false
    this.terminals.set(id, { id, x: pos[0], z: pos[2], radius: 0 })
  }

  private buildRadio(id: string, pos: readonly [number, number, number], radius: number): void {
    const mast = MeshBuilder.CreateCylinder(`prop.${id}.mast`, { diameter: 0.12, height: 1.5 }, this.scene)
    mast.position.set(pos[0], pos[1] + 0.75, pos[2])
    mast.material = this.mats.body
    mast.isPickable = false
    const head = MeshBuilder.CreateBox(`prop.${id}.head`, { width: 0.34, height: 0.22, depth: 0.34 }, this.scene)
    head.position.set(pos[0], pos[1] + 1.56, pos[2])
    head.material = this.mats.body
    head.isPickable = false
    const antenna = MeshBuilder.CreateCylinder(`prop.${id}.ant`, { diameter: 0.035, height: 0.9 }, this.scene)
    antenna.position.set(pos[0], pos[1] + 2.1, pos[2])
    antenna.material = this.mats.antenna
    antenna.isPickable = false
    const sphere = MeshBuilder.CreateSphere(`prop.${id}.sphere`, { diameter: radius * 2, segments: 12 }, this.scene)
    sphere.position.set(pos[0], pos[1] + 1, pos[2])
    sphere.material = this.mats.sphere
    sphere.isPickable = false
    this.radios.set(id, { id, x: pos[0], z: pos[2], radius })
  }

  private buildSwitch(id: string, pos: readonly [number, number, number]): void {
    const cab = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.5, height: 0.85, depth: 0.28 }, this.scene)
    cab.position.set(pos[0], pos[1] + 0.425, pos[2])
    cab.material = this.mats.body
    cab.isPickable = false
    const led = MeshBuilder.CreateBox(`prop.${id}.led`, { width: 0.36, height: 0.05, depth: 0.2 }, this.scene)
    led.position.set(pos[0], pos[1] + 0.88, pos[2])
    led.material = this.mats.led
    led.isPickable = false
    this.switches.set(id, { id, x: pos[0], z: pos[2], radius: 0 })
  }

  private buildDoor(id: string, pos: readonly [number, number, number], axis: 'x' | 'z', size: readonly [number, number, number]): void {
    const [w, h, depth] = size
    const pivot = new TransformNode(`prop.${id}.pivot`, this.scene)
    // Вертикальный выезд (решение владельца): полотно уезжает вверх на свою
    // высоту, как вратарская/шлюз. pivot держит базовую позицию центра.
    pivot.position.set(pos[0], pos[1], pos[2])
    const panel = MeshBuilder.CreateBox(
      `prop.${id}`,
      axis === 'x' ? { width: w, height: h, depth } : { width: depth, height: h, depth: w },
      this.scene,
    )
    panel.parent = pivot
    panel.position.set(0, h / 2, 0)
    panel.material = this.mats.door
    panel.isPickable = false
    panel.enableEdgesRendering(0.95)
    panel.edgesWidth = 2.2
    panel.edgesColor = new Color4(0.22, 1.0, 0.6, 0.7)
    this.doors.set(id, { id, pivot, x: pos[0], z: pos[2], axis, len: w, h, baseY: pos[1], open: false, angle: 0 })
  }

  /** Камера наблюдения (§13.7): кронштейн + корпус + линза + LED владения. */
  private buildCamera(id: string, pos: readonly [number, number, number]): void {
    const body = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.34, height: 0.24, depth: 0.42 }, this.scene)
    body.position.set(pos[0], pos[1], pos[2])
    body.material = this.mats.body
    body.isPickable = false
    const lens = MeshBuilder.CreateCylinder(`prop.${id}.lens`, { diameter: 0.14, height: 0.06 }, this.scene)
    lens.rotation.x = Math.PI / 2
    lens.position.set(pos[0], pos[1], pos[2] + 0.24)
    lens.material = this.mats.antenna
    lens.isPickable = false
    // LED — свой материал на камеру: цвет динамический (владение из снапа).
    const led = new StandardMaterial(`mat.prop.${id}.led`, this.scene)
    led.emissiveColor = new Color3(0.3, 0.38, 0.34)
    led.disableLighting = true
    const ledMesh = MeshBuilder.CreateBox(`prop.${id}.led`, { width: 0.1, height: 0.05, depth: 0.1 }, this.scene)
    ledMesh.position.set(pos[0], pos[1] + 0.16, pos[2])
    ledMesh.material = led
    ledMesh.isPickable = false
    const cam: CameraView = { id, x: pos[0], z: pos[2], led, owner: null }
    this.cameras.set(id, cam)
    this.tintCamera(cam)
  }

  private tintCamera(cam: CameraView): void {
    if (cam.owner === null || this.ownerState === null) {
      cam.led.emissiveColor = new Color3(0.3, 0.38, 0.34) // нейтральная: тускло-серый
      return
    }
    cam.led.emissiveColor =
      this.ownerState(cam.owner) === 'own' ? new Color3(0.22, 1.0, 0.61) : new Color3(1.0, 0.3, 0.82)
  }

  /** Газ (M4 §14.2): AABB-объём ловушки — полупрозрачный fill + каркас из
   *  рёбер. Материал fill'а динамический (цвет/альфа по состоянию из снапа),
   *  каркас — LinesMesh: у него свой цвет без освещения, телеграф-мигание
   *  дешёвое. Клиент никогда не решает «идёт газ» — только рисует open. */
  private buildGas(id: string, pos: readonly [number, number, number], size: readonly [number, number, number]): void {
    const [w, h, d] = size
    const fillMat = new StandardMaterial(`mat.prop.${id}.gas`, this.scene)
    fillMat.disableLighting = true
    fillMat.emissiveColor = GAS_FILL_IDLE
    fillMat.alpha = 0.06
    fillMat.specularColor = Color3.Black()
    const fill = MeshBuilder.CreateBox(`prop.${id}`, { width: w, height: h, depth: d }, this.scene)
    fill.position.set(pos[0], pos[1], pos[2])
    fill.material = fillMat
    fill.isPickable = false
    // каркас — 12 рёбер коробки; линии рисуем явно, enableEdgesRendering на
    // прозрачном боксе дал бы зет-артефакты поверх самого fill'а
    const hx = w / 2
    const hy = h / 2
    const hz = d / 2
    const v = (sx: number, sy: number, sz: number): Vector3 =>
      new Vector3(pos[0] + sx * hx, pos[1] + sy * hy, pos[2] + sz * hz)
    const corners = [
      v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1),
      v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1),
    ]
    const edges: [Vector3, Vector3][] = []
    for (const [a, b] of [
      [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
    ] as const) {
      edges.push([corners[a], corners[b]])
    }
    const frame = MeshBuilder.CreateLineSystem(`prop.${id}.frame`, { lines: edges }, this.scene)
    frame.color = GAS_FRAME_IDLE
    frame.alpha = 0.35
    frame.isPickable = false
    const gas: GasView = { id, x: pos[0], y: pos[1], z: pos[2], w, h, d, fill, fillMat, frame, open: false, armedAt: 0 }
    this.gases.set(id, gas)
    this.paintGas(gas, 0)
  }

  /** Состояние → материалы газа. now — производительное время (мс), от него
   *  считаются телеграф и пульсация; дискретное мигание ~4 Гц (ГДД §14.2). */
  private paintGas(g: GasView, now: number): void {
    const telegraph = g.open && g.armedAt > 0 && now - g.armedAt < GAS_TELEGRAPH_S * 1000
    if (!g.open) {
      g.fillMat.emissiveColor = GAS_FILL_IDLE
      g.fillMat.alpha = 0.06
      g.frame.color = GAS_FRAME_IDLE
      g.frame.alpha = 0.35
    } else if (telegraph) {
      // жёлтое мигание каркаса; fill пока остаётся тусклым — «газ ещё не пошёл»
      g.fillMat.emissiveColor = GAS_FILL_IDLE
      g.fillMat.alpha = 0.06
      g.frame.color = GAS_FRAME_TELEGRAPH
      g.frame.alpha = Math.floor(now / 125) % 2 === 0 ? 0.95 : 0.15 // ~4 Гц
    } else {
      g.fillMat.emissiveColor = GAS_FILL_ACTIVE
      g.fillMat.alpha = 0.25 + 0.06 * Math.sin(now / 260) // лёгкая пульсация плотности
      g.frame.color = GAS_FRAME_ACTIVE
      g.frame.alpha = 0.85
    }
  }

  /** Огонь (M4 §14.6.1): тонкая горящая полоса на плите. Состояние приходит
   *  через snap-пропс клапана (paintFire) — при билде всегда горит (серверный
   *  default open=false); урон/смерть — на сервере (invariant 1). */
  private buildFire(id: string, pos: readonly [number, number, number], size: readonly [number, number, number], valveId: string | null): void {
    const [w, h, d] = size
    const mat = new StandardMaterial(`mat.prop.${id}.fire`, this.scene)
    mat.disableLighting = true
    mat.emissiveColor = FIRE_BASE.clone() // clone: tick() мутирует цвет на месте, база общая
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.alpha = 0.92 // лёгкая прозрачность: пол под полосой читается, край телеграфа виден
    const pool = MeshBuilder.CreateBox(`prop.${id}.fire`, { width: w, height: h, depth: d }, this.scene)
    pool.position.set(pos[0], pos[1], pos[2])
    pool.material = mat
    pool.isPickable = false // ховер-метка — через AABB в propAt, не пикинг меша
    this.fires.set(id, { id, x: pos[0], y: pos[1], z: pos[2], w, h, d, mat, valveId, open: false })
  }

  /** Состояние клапана → материалы связанной полосы огня: горит — оранжевый
   *  (пульсация в tick()), потушен — тёмный + alpha ~0.35, без пульсации.
   *  Мир — общий телеграф (§14.6.1): burn-состояние видно всем без скана. */
  private paintFire(f: FireView): void {
    if (f.open) {
      f.mat.emissiveColor = FIRE_OUT
      f.mat.alpha = 0.35
    } else {
      f.mat.emissiveColor = FIRE_BASE.clone()
      f.mat.alpha = 0.92
    }
  }

  /** Водяной клапан (§14.6.1): кабина-бокс + вертикальная труба к потолку +
   *  вентиль-головка. LED-акцент как у switch'а (сеть та же). */
  private buildValve(id: string, pos: readonly [number, number, number]): void {
    const cab = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.5, height: 0.85, depth: 0.3 }, this.scene)
    cab.position.set(pos[0], pos[1] + 0.425, pos[2])
    cab.material = this.mats.body
    cab.isPickable = false
    // труба «к потолку»: карта не несёт высоту потолка — тянем до 6 м над
    // полом (h=5.15 хватает для обоих этажей m1), лишнее скроется геометрией
    const pipe = MeshBuilder.CreateCylinder(`prop.${id}.pipe`, { diameter: 0.14, height: 5.15 }, this.scene)
    pipe.position.set(pos[0], pos[1] + 0.85 + 5.15 / 2, pos[2])
    pipe.material = this.mats.body
    pipe.isPickable = false
    const head = MeshBuilder.CreateCylinder(`prop.${id}.head`, { diameter: 0.42, height: 0.08 }, this.scene)
    head.position.set(pos[0], pos[1] + 1.05, pos[2])
    head.material = this.mats.led
    head.isPickable = false
    this.valves.set(id, { id, x: pos[0], y: pos[1], z: pos[2], open: false })
  }

  private buildCable(id: string, points: readonly [number, number, number][]): void {
    if (points.length < 2) return
    const cable: CableView = { id, path: points.map((p) => new Vector3(...p)), meshes: [] }
    this.cables.set(id, cable)
    this.rebuildCable(cable)
  }

  private rebuildCable(cable: CableView): void {
    for (const m of cable.meshes) m.dispose()
    cable.meshes = []
    // Кабель — тонкий янтарный жгут (M2-2: несекционируемый, всегда цел).
    const mesh = MeshBuilder.CreateTube(`prop.${cable.id}`, { path: cable.path, radius: 0.06 }, this.scene)
    mesh.enableEdgesRendering(0.95)
    mesh.edgesWidth = 1.5
    mesh.material = this.mats.cable
    mesh.isPickable = false
    cable.meshes = [mesh]
  }

  /** Live state from snap.props (id → state); unknown ids with positions are
   *  created on the fly so a server-side map update still shows up. */
  updateFromSnap(props: readonly SnapProp[]): void {
    let dirty = false
    for (const p of props) {
      switch (p.kind) {
        case 'door': {
          const door = this.doors.get(p.id)
          if (door !== undefined) {
            if (p.open !== undefined && door.open !== p.open) {
              door.open = p.open
              dirty = true
            }
          } else if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
            this.buildDoor(p.id, [p.x, p.y, p.z], 'x', [...DOOR_DEFAULT_SIZE])
            dirty = true
          }
          break
        }
        case 'terminal':
        case 'radio':
        case 'switch': {
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          if (this.known(p.id)) break
          if (p.kind === 'terminal') this.buildTerminal(p.id, [p.x, p.y, p.z])
          else if (p.kind === 'radio') this.buildRadio(p.id, [p.x, p.y, p.z], p.radius ?? DEFAULT_RADIO_RANGE)
          else this.buildSwitch(p.id, [p.x, p.y, p.z])
          dirty = true
          break
        }
        case 'gas': {
          const gas = this.gases.get(p.id)
          if (gas !== undefined) {
            if (p.open !== undefined && gas.open !== p.open) {
              // телеграф считаем от момента наблюдения flip'а 0→1 (ГДД §14.2,
              // п.4: точность долей секунды не нужна, серверный armAt неsync'ится)
              if (p.open) gas.armedAt = performance.now()
              gas.open = p.open
              dirty = true
            }
          } else if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
            this.buildGas(p.id, [p.x, p.y, p.z], [...GAS_DEFAULT_SIZE])
            // газ мог приехать уже с открытым клапаном (проп создался позже
            // взвода) — состояние ставим сразу, иначе каркас соврёт до первого flip
            const created = this.gases.get(p.id)
            if (created !== undefined && p.open === true) {
              created.open = true
              created.armedAt = performance.now()
            }
            dirty = true
          }
          break
        }
        case 'camera': {
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          const cam = this.cameras.get(p.id)
          if (cam === undefined) {
            this.buildCamera(p.id, [p.x, p.y, p.z])
            dirty = true
          }
          const owner = p.owner ?? null
          const known = this.cameras.get(p.id)
          if (known !== undefined && known.owner !== owner) {
            known.owner = owner
            this.tintCamera(known)
          }
          break
        }
        case 'valve': {
          // Клапан (§14.6.1) — как дверь/газ: open из снапа; смена open
          // перекрашивает полосы огня, привязанные к нему полем to.
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          let valve = this.valves.get(p.id)
          if (valve === undefined) {
            this.buildValve(p.id, [p.x, p.y, p.z])
            valve = this.valves.get(p.id)
            dirty = true
          }
          if (valve !== undefined && p.open !== undefined && valve.open !== p.open) {
            valve.open = p.open
            for (const f of this.fires.values()) {
              if (f.valveId === p.id && f.open !== p.open) {
                f.open = p.open
                this.paintFire(f)
              }
            }
          }
          break
        }
      }
    }
    if (dirty) this.rebuildMini()
  }

  /** Анимация дверей: доворот к целевому углу, ~0.3 с на 90°. */
  /** Пропс под прицелом (ховер-метка): ближайший AABB на луче. */
  propAt(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist: number): string | null {
    let best: string | null = null
    let bestT = maxDist
    const boxes: { label: string; min: [number, number, number]; max: [number, number, number] }[] = []
    for (const d of this.doors.values()) {
      const halfW = d.axis === 'x' ? d.len / 2 : 0.15
      const halfD = d.axis === 'z' ? d.len / 2 : 0.15
      boxes.push({ label: `ДВЕРЬ ${d.id.toUpperCase()} — ${d.open ? 'ОТКРЫТА' : 'ЗАКРЫТА'}`, min: [d.x - halfW, d.baseY, d.z - halfD], max: [d.x + halfW, d.baseY + d.h, d.z + halfD] })
    }
    for (const t of this.terminals.values()) {
      boxes.push({ label: `ТЕРМИНАЛ ${t.id.toUpperCase()}`, min: [t.x - 0.6, 1, t.z - 0.6], max: [t.x + 0.6, 2.4, t.z + 0.6] })
    }
    for (const r of this.radios.values()) {
      boxes.push({ label: `РАДИО-ТОЧКА ${r.id.toUpperCase()}`, min: [r.x - 0.7, 1, r.z - 0.7], max: [r.x + 0.7, 3, r.z + 0.7] })
    }
    for (const s of this.switches.values()) {
      boxes.push({ label: `SWITCH ${s.id.toUpperCase()}`, min: [s.x - 0.5, 1, s.z - 0.5], max: [s.x + 0.5, 1.9, s.z + 0.5] })
    }
    for (const g of this.gases.values()) {
      boxes.push({ label: `ГАЗ ${g.id.toUpperCase()} — КЛАПАН ${g.open ? 'ОТКРЫТ' : 'ЗАКРЫТ'}`, min: [g.x - g.w / 2, g.y - g.h / 2, g.z - g.d / 2], max: [g.x + g.w / 2, g.y + g.h / 2, g.z + g.d / 2] })
    }
    for (const f of this.fires.values()) {
      boxes.push({ label: `ОГОНЬ ${f.id.toUpperCase()} — ${f.open ? 'ПОТУШЕН' : 'ГОРИТ'}`, min: [f.x - f.w / 2, f.y - f.h / 2, f.z - f.d / 2], max: [f.x + f.w / 2, f.y + f.h / 2, f.z + f.d / 2] })
    }
    for (const v of this.valves.values()) {
      boxes.push({ label: `КЛАПАН ${v.id.toUpperCase()} — ВОДА ${v.open ? 'ИДЁТ' : 'ЗАКРЫТА'}`, min: [v.x - 0.5, v.y, v.z - 0.5], max: [v.x + 0.5, v.y + 1.3, v.z + 0.5] })
    }
    for (const c of this.cameras.values()) {
      const state =
        c.owner === null
          ? 'НЕЙТРАЛЬНАЯ'
          : this.ownerState !== null
            ? this.ownerState(c.owner) === 'own'
              ? 'СВОЯ'
              : 'ЧУЖАЯ'
            : 'ЗАХВАЧЕНА'
      boxes.push({ label: `КАМЕРА ${c.id.toUpperCase()} — ${state}`, min: [c.x - 0.5, 1.8, c.z - 0.5], max: [c.x + 0.5, 3.4, c.z + 0.5] })
    }
    // Кабели: наводка показывает id (топология — визуализация, §6).
    for (const c of this.cables.values()) {
      if (c.path.length < 2) continue
      for (let i = 0; i + 1 < c.path.length; i++) {
        const a = c.path[i]
        const b = c.path[i + 1]
        const min: [number, number, number] = [Math.min(a.x, b.x) - 0.25, Math.min(a.y, b.y) - 0.25, Math.min(a.z, b.z) - 0.25]
        const max: [number, number, number] = [Math.max(a.x, b.x) + 0.25, Math.max(a.y, b.y) + 0.25, Math.max(a.z, b.z) + 0.25]
        boxes.push({ label: `КАБЕЛЬ ${c.id.toUpperCase()}`, min, max })
      }
    }
    for (const b of boxes) {
      const t = rayBoxAABB(origin, dir, b.min, b.max)
      if (t !== null && t < bestT) {
        bestT = t
        best = b.label
      }
    }
    return best
  }

  /** AABB закрытых дверей — автоогонь/LOS клиента не видят врагов за ними. */
  closedDoorBoxes(): { min: [number, number, number]; max: [number, number, number] }[] {
    const out: { min: [number, number, number]; max: [number, number, number] }[] = []
    for (const d of this.doors.values()) {
      if (d.open) continue
      // дверь: центр (x, baseY, z), ось x — панель вдоль X; вдоль Z — вдоль Z
      const halfW = d.axis === 'x' ? d.len / 2 : 0.15
      const halfD = d.axis === 'z' ? d.len / 2 : 0.15
      out.push({
        min: [d.x - halfW, d.baseY, d.z - halfD],
        max: [d.x + halfW, d.baseY + d.h, d.z + halfD],
      })
    }
    return out
  }

  /** Угол створки двери (для e2e-проверок анимации). */
  doorAngle(id: string): number | null {
    return this.doors.get(id)?.angle ?? null
  }

  tick(dtSec: number): void {
    const step = Math.min(1, dtSec / DOOR_SWING_S)
    for (const d of this.doors.values()) {
      const target = d.open ? 1 : 0
      const delta = target - d.angle
      if (Math.abs(delta) <= 1e-4) continue
      d.angle += Math.sign(delta) * Math.min(step, Math.abs(delta))
      // выезд вверх: центр полотна поднимается на высоту двери
      d.pivot.position.y = d.baseY + d.h * d.angle
    }
    // газ: телеграф/пульсация считаются от производительного времени кадра
    if (this.gases.size > 0) {
      const now = performance.now()
      for (const g of this.gases.values()) this.paintGas(g, now)
    }
    // огонь: дешёвое «кипение» — пульсация эмиссива 0.9..1.1 на ~0.6 Гц
    // (ГДД §14.6.1). Только горящие полосы; потушенные стоят тёмными.
    if (this.fires.size > 0) {
      const k = 1 + 0.1 * Math.sin((performance.now() / 1000) * Math.PI * 2 * FIRE_PULSE_HZ)
      for (const f of this.fires.values()) {
        if (f.open) continue
        f.mat.emissiveColor.copyFromFloats(FIRE_BASE.r * k, FIRE_BASE.g * k, FIRE_BASE.b * k)
      }
    }
  }

  /** Ближайшая точка джек-ина для хакера (терминал 2 м / радио 8 м, GDD §12.1). */
  /** Ближайшая точка входа вообще (для подсказки «подойди ближе»). */
  nearestJackPoint(x: number, z: number): { id: string; kind: 'terminal' | 'radio'; dist: number; range: number } | null {
    let best: { id: string; kind: 'terminal' | 'radio'; dist: number; range: number } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const t of this.terminals.values()) {
      const d = Math.hypot(t.x - x, t.z - z)
      if (d / TERMINAL_RANGE < bestScore) {
        bestScore = d / TERMINAL_RANGE
        best = { id: t.id, kind: 'terminal', dist: d, range: TERMINAL_RANGE }
      }
    }
    for (const r of this.radios.values()) {
      const d = Math.hypot(r.x - x, r.z - z)
      const range = r.radius ?? DEFAULT_RADIO_RANGE
      if (d / range < bestScore) {
        bestScore = d / range
        best = { id: r.id, kind: 'radio', dist: d, range }
      }
    }
    return best
  }

  nearestJackIn(x: number, z: number): { id: string; kind: 'terminal' | 'radio' } | null {
    let best: { id: string; kind: 'terminal' | 'radio' } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const t of this.terminals.values()) {
      const d = Math.hypot(t.x - x, t.z - z)
      const score = d / TERMINAL_RANGE
      if (d <= TERMINAL_RANGE && score < bestScore) {
        bestScore = score
        best = { id: t.id, kind: 'terminal' }
      }
    }
    for (const r of this.radios.values()) {
      const d = Math.hypot(r.x - x, r.z - z)
      const score = d / r.radius
      if (d <= r.radius && score < bestScore) {
        bestScore = score
        best = { id: r.id, kind: 'radio' }
      }
    }
    return best
  }

  hostKind(id: string): CyberKind | null {
    if (this.terminals.has(id)) return 'terminal'
    if (this.radios.has(id)) return 'radio'
    if (this.switches.has(id)) return 'switch'
    if (this.doors.has(id)) return 'door'
    if (this.valves.has(id)) return 'valve'
    return null
  }

  miniProps(): readonly MiniProp[] {
    return this.miniCache
  }

  private known(id: string): boolean {
    return this.terminals.has(id) || this.radios.has(id) || this.switches.has(id) || this.doors.has(id) ||
      this.cameras.has(id) || this.gases.has(id) || this.fires.has(id) || this.valves.has(id)
  }

  private rebuildMini(): void {
    const out: MiniProp[] = []
    for (const t of this.terminals.values()) out.push({ x: t.x, z: t.z, kind: 'terminal' })
    for (const r of this.radios.values()) out.push({ x: r.x, z: r.z, kind: 'radio' })
    for (const s of this.switches.values()) out.push({ x: s.x, z: s.z, kind: 'switch' })
    for (const c of this.cameras.values()) out.push({ x: c.x, z: c.z, kind: 'camera' })
    for (const d of this.doors.values()) {
      out.push({ x: d.x, z: d.z, kind: 'door', open: d.open, axis: d.axis, len: d.len })
    }
    for (const g of this.gases.values()) {
      out.push({ x: g.x, z: g.z, kind: 'gas', open: g.open })
    }
    // Огонь — ландшафт-опасность, но его burn-состояние полезно на миникарте
    // (§14.6.1: «burn-состояние пула видно всем»); клапан — обычный девайс.
    for (const f of this.fires.values()) {
      out.push({ x: f.x, z: f.z, kind: 'fire', open: f.open })
    }
    for (const v of this.valves.values()) {
      out.push({ x: v.x, z: v.z, kind: 'valve', open: v.open })
    }
    this.miniCache = out
  }
}


function rayBoxAABB(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, min: readonly [number, number, number], max: readonly [number, number, number]): number | null {
  let tmin = 0
  let tmax = Number.POSITIVE_INFINITY
  const os = [o.x, o.y, o.z]
  const ds = [d.x, d.y, d.z]
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ds[i]) < 1e-12) {
      if (os[i] < min[i] || os[i] > max[i]) return null
      continue
    }
    const inv = 1 / ds[i]
    let t1 = (min[i] - os[i]) * inv
    let t2 = (max[i] - os[i]) * inv
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  return tmin
}
