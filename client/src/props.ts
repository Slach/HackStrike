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
  locked: boolean
}

const PROP_KINDS: readonly PropKind[] = ['terminal', 'radio', 'switch', 'door', 'camera', 'cable', 'gas', 'fire', 'valve', 'srv', 'keypad', 'safe', 'physafe', 'lift', 'liftbtn']

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
      locked: r.locked === true,
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
  y: number
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
  fy: number
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

/** Водяной клапан (§14.6.1): настенный щиток с вентилем (позиция прижата к
 *  стене в карте), труба-хвост по полу к своей полосе огня. Сеть и
 *  таб-управление — в hackview (CyberKind); здесь только геометрия/ховер. */
interface ValveView {
  id: string
  x: number
  z: number
  y: number
  open: boolean
  /** Труба к полосе строится один раз, когда клапан и полоба оба известны. */
  pipeBuilt: boolean
  pipeMeshes: Mesh[]
}

export class PropsView {
  private readonly terminals = new Map<string, SimpleProp>()
  private readonly radios = new Map<string, SimpleProp>()
  private readonly switches = new Map<string, SimpleProp>()
  /** §16.6: NETSAFE-сейфы — отдельная карта: свой тултип/джек-лейбл
   *  («NETSAFE», не «ТЕРМИНАЛ») и свой глиф на миникарте. */
  private readonly safes = new Map<string, SimpleProp>()
  /** §16.6: PHYSAFE — динамический проп (ездит с носителем), отдельные
   *  меши и позиция; обновляется из snap.props каждый тик. */
  private physafeParts: Mesh[] = []
  private physafePos: { x: number; y: number; z: number; carrier: number } | null = null
  /** §16.12: платформы лифтов — per-lift состояние: меши + лерп-Y
   *  (снапы 20 Гц, платформа движется — без сглаживания дёргается). */
  private lifts = new Map<
    string,
    { parts: Mesh[]; x: number; z: number; half: number; thick: number; curY: number; targetY: number; cap: Mesh }
  >()
  private readonly liftBtns = new Map<string, SimpleProp>()
  /** Текущая отрисованная позиция меша — lerp к снап-цели (носитель
   *  движется плавно, снапы 20 Гц — без lerp сейф дёргается). */
  private physafeCur: { x: number; y: number; z: number } | null = null
  private readonly doors = new Map<string, DoorView>()
  /** §16.7: двери с код-замком и клавиатуры (space у клавиатуры → пад). */
  private readonly lockedDoors = new Set<string>()
  private readonly codeDoors = new Map<string, SimpleProp & { door: string }>()
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
  /** Коллайдеры стен (kind 'wall') — propAt не показывает пропсы сквозь стены
   *  (плейтест: наводка на клавиатуру за стеной отвечала «ОГОНЬ LV3 — ГОРИТ»). */
  private walls: { min: [number, number, number]; max: [number, number, number] }[] = []

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
      // Водопроводные трубы — приглушённый синий (ревебр owner): отличим от
      // янтарных сетевых кабелей, не спорит с оранжевым огнём.
      pipe: glow('pipe', [0.16, 0.3, 0.5]),
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
        case 'srv':
          view.buildSrv(prop.id, prop.pos)
          break
        case 'safe':
          view.buildSafe(prop.id, prop.pos)
          break
        case 'physafe':
          view.buildPhysafe(prop.id, prop.pos)
          break
        case 'lift':
          view.buildLift(prop.id, prop.pos, prop.size ?? [2.7, 0.85, 2.7])
          break
        case 'liftbtn':
          view.buildLiftBtn(prop.id, prop.pos)
          break
        case 'keypad':
          view.buildKeypad(prop.id, prop.pos, prop.to)
          break
        case 'radio':
          view.buildRadio(prop.id, prop.pos, prop.radius)
          break
        case 'switch':
          view.buildSwitch(prop.id, prop.pos)
          break
        case 'door':
          view.buildDoor(prop.id, prop.pos, prop.axis, prop.size, prop.locked)
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
    view.walls = map.colliders
      .filter((c) => c.kind === 'wall')
      .map((c) => ({ min: c.min, max: c.max }))
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
    this.terminals.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0 })
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
    this.radios.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius })
  }

  /** SRV (§16.5): серверная стойка — выше и толще терминала. */
  private buildSrv(id: string, pos: readonly [number, number, number]): void {
    const tower = MeshBuilder.CreateBox(`prop.${id}`, { width: 1.2, height: 2.2, depth: 0.8 }, this.scene)
    tower.position.set(pos[0], pos[1] + 1.1, pos[2])
    tower.material = this.mats.body
    tower.isPickable = false
    const led = MeshBuilder.CreateBox(`prop.${id}.led`, { width: 0.9, height: 0.08, depth: 0.6 }, this.scene)
    led.position.set(pos[0], pos[1] + 2.26, pos[2])
    led.material = this.mats.led
    led.isPickable = false
    this.terminals.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0 })
  }

  /** §16.6: NETSAFE — тумба-сейф у s3: корпус + дверца с ручкой. Хранит
   *  safe_key; без щита (защита = дверь-код + лава + дистанция, §16.6). */
  private buildSafe(id: string, pos: readonly [number, number, number]): void {
    const body = MeshBuilder.CreateBox(`prop.${id}`, { width: 1.0, height: 1.1, depth: 1.0 }, this.scene)
    body.position.set(pos[0], pos[1] + 0.55, pos[2])
    body.material = this.mats.body
    body.isPickable = false
    const face = MeshBuilder.CreateBox(`prop.${id}.face`, { width: 0.7, height: 0.7, depth: 0.06 }, this.scene)
    face.position.set(pos[0], pos[1] + 0.55, pos[2] + 0.51)
    face.material = this.mats.pipe // приглушённый синий — отличим от терминала
    face.isPickable = false
    const handle = MeshBuilder.CreateCylinder(`prop.${id}.h`, { diameter: 0.08, height: 0.3 }, this.scene)
    handle.position.set(pos[0] + 0.22, pos[1] + 0.55, pos[2] + 0.55)
    handle.rotation.z = Math.PI / 2
    handle.material = this.mats.led
    handle.isPickable = false
    this.safes.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0 })
  }

  /** §16.6: PHYSAFE — янтарный сейф за код-дверьми (вне сети). Меши
   *  переезжают из snap.props: на земле — на месте, carriedBy — у носителя. */
  private buildPhysafe(id: string, pos: readonly [number, number, number]): void {
    const body = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.9, height: 0.9, depth: 0.9 }, this.scene)
    body.position.set(pos[0], pos[1] + 0.45, pos[2])
    body.material = this.mats.body
    body.isPickable = false
    const face = MeshBuilder.CreateBox(`prop.${id}.face`, { width: 0.6, height: 0.6, depth: 0.06 }, this.scene)
    face.position.set(pos[0], pos[1] + 0.45, pos[2] + 0.47)
    face.material = this.mats.cable // янтарь — гонка за сейфом видна издалека
    face.isPickable = false
    const led = MeshBuilder.CreateBox(`prop.${id}.led`, { width: 0.2, height: 0.05, depth: 0.1 }, this.scene)
    led.position.set(pos[0], pos[1] + 0.95, pos[2])
    led.material = this.mats.cable
    led.isPickable = false
    this.physafeParts = [body, face, led]
    this.physafePos = { x: pos[0], y: pos[1], z: pos[2], carrier: 0 }
    this.physafeCur = { x: pos[0], y: pos[1], z: pos[2] }
  }

  /** §16.12: платформа лифта — едет между этажами по снапу (лерп в tick). */
  private buildLift(id: string, pos: readonly [number, number, number], size: readonly [number, number, number]): void {
    const [w, h, d] = size
    const plat = MeshBuilder.CreateBox(`prop.${id}`, { width: w, height: h, depth: d }, this.scene)
    plat.position.set(pos[0], pos[1] - h / 2, pos[2])
    plat.material = this.mats.body
    plat.isPickable = false
    const edge = MeshBuilder.CreateBox(`prop.${id}.edge`, { width: w, height: 0.05, depth: d }, this.scene)
    edge.position.set(pos[0], pos[1] - 0.02, pos[2])
    edge.material = this.mats.cable // янтарная кромка — видно, где площадка
    edge.isPickable = false
    // крышка проёма 2F: появляется, когда платформа спустилась (плейтест
    // «тупо дыра остаётся… проваливаешься»)
    const cap = MeshBuilder.CreateBox(`prop.${id}.cap`, { width: w, height: h, depth: d }, this.scene)
    cap.position.set(pos[0], 8 - h / 2, pos[2])
    cap.material = this.mats.body
    cap.isVisible = false
    // окаймляющие грани проёма + направляющие шахты (плейтест «потолок
    // вообще бездонный =)… надо потолок визуализировать»): янтарная рама
    // по периметру дыры на НИЖНЕЙ грани плиты 2F (y=7) + 4 стойки-рельса
    // до пола 1F — шахта читается и сверху, и при спуске
    const rimY = 7 - 0.05
    const rimD = d / 2 + 0.12
    const rimMat = this.mats.cable
    const rims: [number, number, number, number, number, number][] = [
      // вдоль X (север/юг грани)
      [pos[0], rimY, pos[2] - rimD, w + 0.24, 0.1, 0.12],
      [pos[0], rimY, pos[2] + rimD, w + 0.24, 0.1, 0.12],
      // вдоль Z (запад/восток грани)
      [pos[0] - rimD, rimY, pos[2], 0.12, 0.1, d + 0.24],
      [pos[0] + rimD, rimY, pos[2], 0.12, 0.1, d + 0.24],
    ]
    for (let i = 0; i < rims.length; i++) {
      const [rx, ry, rz, rw, rh, rd] = rims[i]
      const rim = MeshBuilder.CreateBox(`prop.${id}.rim${i}`, { width: rw, height: rh, depth: rd }, this.scene)
      rim.position.set(rx, ry, rz)
      rim.material = rimMat
      rim.isPickable = false
    }
    // рельсы по углам: от пола 1F до плиты 2F
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const rail = MeshBuilder.CreateBox(`prop.${id}.rail${sx}${sz}`, { width: 0.08, height: 7, depth: 0.08 }, this.scene)
        rail.position.set(pos[0] + sx * rimD, 4.5, pos[2] + sz * rimD)
        rail.material = rimMat
        rail.isPickable = false
      }
    }
    this.lifts.set(id, {
      parts: [plat, edge],
      x: pos[0],
      z: pos[2],
      half: w / 2,
      thick: h,
      curY: pos[1],
      targetY: pos[1],
      cap,
    })
  }

  /** §16.12: кнопка-пьедестал лифта на 2F — физика, space. */
  private buildLiftBtn(id: string, pos: readonly [number, number, number]): void {
    const ped = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.34, height: 1.1, depth: 0.34 }, this.scene)
    ped.position.set(pos[0], pos[1] + 0.55, pos[2])
    ped.material = this.mats.body
    ped.isPickable = false
    const lamp = MeshBuilder.CreateBox(`prop.${id}.lamp`, { width: 0.22, height: 0.16, depth: 0.08 }, this.scene)
    lamp.position.set(pos[0], pos[1] + 1.1, pos[2])
    lamp.material = this.mats.cable
    lamp.isPickable = false
    this.liftBtns.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0 })
  }

  /** §16.7: маленькая клавиатура-пропс у запертой двери — точка space.
   *  Решение владельца: «сама физическая клава пусть будет 10 точек» —
   *  сетка 3×4 цифровых точек (1–9, 0), а не параллелепипед.
   *  Плоскость клавиатуры — на стену: тонкая подложка разворачивается к
   *  комнате по положению (стена z-плоскости или x-плоскости). */
  private buildKeypad(id: string, pos: readonly [number, number, number], to: string | null): void {
    if (to === null) return
    // какая ось стены: далеко по z от центра — стена z-плоскости (k3/k4),
    // далеко по x — x-плоскости (k5/k6)
    const alongZ = Math.abs(pos[2] - 32) > Math.abs(pos[0] - 32)
    const cx = pos[0]
    const cy = pos[1] + 1.3
    const cz = pos[2]
    const backing = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.3, height: 0.4, depth: 0.05 }, this.scene)
    backing.position.set(cx, cy, cz)
    if (alongZ) backing.rotation.y = 0
    else backing.rotation.y = Math.PI / 2
    backing.material = this.mats.body
    backing.isPickable = false
    // 10 точек: 3 колонки × 3 ряда + нижняя «0», шаг 0.08/0.09
    const dotR = 0.022
    const cols = [-0.08, 0, 0.08]
    const rows = [0.11, 0.02, -0.07, -0.16]
    const keys: [number, number][] = [
      [cols[0], rows[0]], [cols[1], rows[0]], [cols[2], rows[0]],
      [cols[0], rows[1]], [cols[1], rows[1]], [cols[2], rows[1]],
      [cols[0], rows[2]], [cols[1], rows[2]], [cols[2], rows[2]],
      [cols[1], rows[3]],
    ]
    // Точки — ОТ центра карты (наружу): клавиатуры висят на внешних стенах,
    // кнопки должны смотреть на игрока, идущего к комнате (плейтест:
    // «кнопки в другую сторону разверни, не в центр, а от центра»).
    const off = 0.05
    for (let i = 0; i < keys.length; i++) {
      const dot = MeshBuilder.CreateSphere(`prop.${id}.k${i}`, { diameter: dotR * 2, segments: 6 }, this.scene)
      const [dx, dy] = keys[i]
      if (alongZ) {
        const dz = Math.sign(cz - 32) * off
        dot.position.set(cx + dx, cy + dy, cz + dz)
      } else {
        const ddx = Math.sign(cx - 32) * off
        dot.position.set(cx + ddx, cy + dy, cz + dx)
      }
      dot.material = this.mats.led
      dot.isPickable = false
    }
    this.codeDoors.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0, door: to })
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
    this.switches.set(id, { id, x: pos[0], y: pos[1], z: pos[2], radius: 0 })
  }

  private buildDoor(
    id: string,
    pos: readonly [number, number, number],
    axis: 'x' | 'z',
    size: readonly [number, number, number],
    locked = false,
  ): void {
    if (locked) this.lockedDoors.add(id)
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
    // Сервисный порт двери (§12.1 «дорогой вход», плейтест 2026-11-17:
    // «странно в стенку стоять и смотреть»; ревизия: «на одной двери замок
    // изнутри, на второй снаружи») — щиток с проводами и LED на ОБЕИХ
    // сторонах полотна у пола: замок виден, с какой стороны ни подошёл.
    // Едет с полотном.
    const portOff = w / 2 - 0.25 // у края полотна по его длинной оси
    const ledMat = new StandardMaterial(`mat.prop.${id}.portled`, this.scene)
    ledMat.emissiveColor = new Color3(0.15, 0.7, 0.35)
    ledMat.disableLighting = true
    for (const face of [1, -1]) {
      // face=1 — «передняя» сторона по нормали (z для axis x, x для axis z)
      const px = axis === 'x' ? portOff : (depth / 2 + 0.04) * face
      const pz = axis === 'x' ? (depth / 2 + 0.04) * face : portOff
      const port = MeshBuilder.CreateBox(`prop.${id}.port${face}`, { width: 0.26, height: 0.36, depth: 0.08 }, this.scene)
      port.parent = panel
      port.position.set(px, -h / 2 + 0.5, pz)
      if (axis === 'z') port.rotation.y = Math.PI / 2 // тонкой стороной из полотна
      port.material = this.mats.body
      port.isPickable = false
      for (const wx of [-0.06, 0.06]) {
        const wire = MeshBuilder.CreateCylinder(`prop.${id}.wire${face}`, { diameter: 0.025, height: 0.42 }, this.scene)
        wire.parent = panel
        wire.position.set(
          px + (axis === 'x' ? wx : 0),
          -h / 2 + 0.24,
          pz + (axis === 'x' ? 0 : wx),
        )
        wire.material = this.mats.antenna
        wire.isPickable = false
      }
      const led = MeshBuilder.CreateBox(`prop.${id}.portled${face}`, { width: 0.08, height: 0.05, depth: 0.03 }, this.scene)
      led.parent = panel
      led.position.set(
        px + (axis === 'x' ? 0 : 0.05 * face),
        -h / 2 + 0.72,
        pz + (axis === 'x' ? 0.05 * face : 0),
      )
      led.material = ledMat
      led.isPickable = false
    }
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
    const cam: CameraView = { id, x: pos[0], z: pos[2], fy: pos[1], led, owner: null }
    this.cameras.set(id, cam)
    this.tintCamera(cam)
  }

  private tintCamera(cam: CameraView): void {
    if (cam.owner === null || this.ownerState === null) {
      cam.led.emissiveColor = new Color3(0.3, 0.38, 0.34) // нейтральная: тускло-серый
      return
    }
    // LED владения: своё — белый (WhiteHat/союзник), чужое — красный
    // (чёрный LED не виден на тёмном корпусе камеры).
    cam.led.emissiveColor =
      this.ownerState(cam.owner) === 'own' ? new Color3(1, 1, 1) : new Color3(1.0, 0.3, 0.37)
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
    if (valveId !== null) this.tryValvePipe(valveId) // полоса знает клапан — достраиваем трубу
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

  /** Водяной клапан (§14.6.1, ревебр owner): на потолке при y>5 (карта
   *  задаёт точку подвеса: кабина висит под плитой
   *  y=7 / крышей y=15, маховик снизу) или на стене при низком y (щиток,
   *  маховик сверху). Труба к полосе — отдельным проходом (tryValvePipe):
   *  порядок постройки fire/valve в props не гарантирован.
   *  LED-акцент как у switch'а (сеть та же). */
  private buildValve(id: string, pos: readonly [number, number, number]): void {
    const ceiling = pos[1] > 5 // v1/v2 под плитой (y≈6.1), v3 под крышей (y≈14.1)
    const cab = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.5, height: 0.85, depth: 0.3 }, this.scene)
    cab.position.set(pos[0], pos[1] + 0.425, pos[2])
    cab.material = this.mats.body
    cab.isPickable = false
    const head = MeshBuilder.CreateCylinder(`prop.${id}.head`, { diameter: 0.42, height: 0.08 }, this.scene)
    // на потолке маховик снизу кабины (тянешь вниз), на стене — сверху
    head.position.set(pos[0], ceiling ? pos[1] - 0.2 : pos[1] + 1.05, pos[2])
    head.material = this.mats.led
    head.isPickable = false
    this.valves.set(id, { id, x: pos[0], y: pos[1], z: pos[2], open: false, pipeBuilt: false, pipeMeshes: [] })
    this.tryValvePipe(id)
  }

  /** Труба клапана → полоса (§14.6.1, ревебр owner «вертикально спускаться
   *  по стене, потом по полу»): от потолочного клапана строго вниз вдоль
   *  стены (x,z клапана = прижаты к стене в карте), затем по полу до центра
   *  своей полосы. Приглушённый синий (mats.pipe). Идемпотентна — вызывается
   *  и из buildValve, и из buildFire (кто вторым узнал про обе половины,
   *  тот и построил). */
  private tryValvePipe(id: string): void {
    const v = this.valves.get(id)
    if (v === undefined || v.pipeBuilt) return
    const fire = [...this.fires.values()].find((f) => f.valveId === id)
    if (fire === undefined) return
    const floorY = fire.y - fire.h / 2 // верх плиты, на которой стоит полоса
    // Пол: прямоугольный излом (ревебр owner) — сначала вдоль стены по оси z
    // до z полосы, затем поперёк по x к её центру. Для v3 (z совпадает)
    // средняя точка вырождается — не добавляем её вовсе.
    const pts = [new Vector3(v.x, v.y, v.z), new Vector3(v.x, floorY, v.z)]
    if (Math.abs(v.z - fire.z) > 1e-6) pts.push(new Vector3(v.x, floorY, fire.z))
    pts.push(new Vector3(fire.x, floorY, fire.z))
    const pipe = MeshBuilder.CreateTube(`prop.${id}.pipe`, { path: pts, radius: 0.09 }, this.scene)
    pipe.material = this.mats.pipe
    pipe.isPickable = false
    v.pipeBuilt = true
    v.pipeMeshes = [pipe]
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
        case 'srv':
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          if (this.known(p.id)) break
          this.buildSrv(p.id, [p.x, p.y, p.z])
          dirty = true
          break
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
        case 'lift': {
          // §16.12: платформа едет — пишем target-Y, меш догоняет лерпом
          const l = this.lifts.get(p.id)
          if (l !== undefined && p.y !== undefined && Math.abs(l.targetY - p.y) > 0.01) {
            l.targetY = p.y
          }
          break
        }
        case 'physafe': {
          // §16.6: позиция из снапа (на земле или у носителя); перенос меша
          // + глиф миникарты (rebuildMini дёшев, карта маленькая)
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          const cur = this.physafePos
          const moved =
            cur === null ||
            Math.abs(cur.x - p.x) > 0.01 ||
            Math.abs(cur.y - p.y) > 0.01 ||
            Math.abs(cur.z - p.z) > 0.01 ||
            cur.carrier !== (p.carriedBy ?? 0)
          if (!moved) break
          this.physafePos = { x: p.x, y: p.y, z: p.z, carrier: p.carriedBy ?? 0 }
          dirty = true // глиф миникарты сразу; меши догонят лерпом в tick()
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
    // Терминал/радио/switch: высота от реальной точки пропса (как у камер —
    // плейтест). Жёсткие 1F-высоты (1..2.4) делали t3/s3 2 этажа ненаводимыми:
    // луч ловил плиту лавы lv3, лежащую теперь по всему полу комнаты.
    for (const t of this.terminals.values()) {
      boxes.push({ label: `ТЕРМИНАЛ ${t.id.toUpperCase()}`, min: [t.x - 0.6, t.y, t.z - 0.6], max: [t.x + 0.6, t.y + 1.4, t.z + 0.6] })
    }
    for (const sf of this.safes.values()) {
      boxes.push({ label: `NETSAFE ${sf.id.toUpperCase()}`, min: [sf.x - 0.6, sf.y, sf.z - 0.6], max: [sf.x + 0.6, sf.y + 1.2, sf.z + 0.6] })
    }
    for (const r of this.radios.values()) {
      boxes.push({ label: `РАДИО-ТОЧКА ${r.id.toUpperCase()}`, min: [r.x - 0.7, r.y, r.z - 0.7], max: [r.x + 0.7, r.y + 2, r.z + 0.7] })
    }
    for (const s of this.switches.values()) {
      boxes.push({ label: `SWITCH ${s.id.toUpperCase()}`, min: [s.x - 0.5, s.y, s.z - 0.5], max: [s.x + 0.5, s.y + 0.9, s.z + 0.5] })
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
      // высота — от реальной точки пропса (первый этаж 2.6, второй 9.6):
      // жёсткие 1.8..3.4 делали камеры 2 этажа ненаводимыми (плейтест)
      boxes.push({ label: `КАМЕРА ${c.id.toUpperCase()} — ${state}`, min: [c.x - 0.5, c.fy - 0.8, c.z - 0.5], max: [c.x + 0.5, c.fy + 0.8, c.z + 0.5] })
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
    // §16.12: платформы лифтов (динамические по Y) и кнопки
    for (const l of this.lifts.values()) {
      boxes.push({ label: 'ЛИФТ — SPACE: СПУСК (КНОПКА РЯДОМ)', min: [l.x - l.half, l.curY - 0.2, l.z - l.half], max: [l.x + l.half, l.curY + 0.2, l.z + l.half] })
    }
    for (const b of this.liftBtns.values()) {
      boxes.push({ label: 'КНОПКА ЛИФТА — SPACE: СПУСК НА 1F', min: [b.x - 0.3, b.y, b.z - 0.3], max: [b.x + 0.3, b.y + 1.3, b.z + 0.3] })
    }
    // PHYSAFE (§16.6): динамический бокс — на земле или у носителя
    if (this.physafePos !== null) {
      const pf = this.physafePos
      boxes.push({ label: `PHYSAFE — SPACE: ВЗЯТЬ${pf.carrier !== 0 ? ' (У НОСИТЕЛЯ)' : ''}`, min: [pf.x - 0.5, pf.y, pf.z - 0.5], max: [pf.x + 0.5, pf.y + 1, pf.z + 0.5] })
    }
    // Клавиатуры код-замков (§16.7): иначе наводка на панель ловила бокс
    // огня за стеной — у клавиатур вообще не было AABB в этом списке.
    for (const k of this.codeDoors.values()) {
      boxes.push({
        label: `ЗАМОК ${k.door.toUpperCase()} — КОДОВАЯ КЛАВИАТУРА`,
        min: [k.x - 0.25, k.y + 1.0, k.z - 0.25],
        max: [k.x + 0.25, k.y + 1.6, k.z + 0.25],
      })
    }
    for (const b of boxes) {
      const t = rayBoxAABB(origin, dir, b.min, b.max)
      if (t === null || t >= bestT) continue
      if (this.wallBlocked(origin, dir, t)) continue
      bestT = t
      best = b.label
    }
    return best
  }

  /** Стена между глазом и точкой хита на дистанции tHit? Пропсы висят НА
   *  стенах (клавиатура на поверхности, дверь в проёме), поэтому хит в толще
   *  стены или глаз в ней — эта стена не считается заслоном. */
  private wallBlocked(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, tHit: number): boolean {
    const hit: [number, number, number] = [origin.x + dir.x * tHit, origin.y + dir.y * tHit, origin.z + dir.z * tHit]
    const inside = (p: readonly number[], w: { min: [number, number, number]; max: [number, number, number] }): boolean =>
      p[0] >= w.min[0] && p[0] <= w.max[0] && p[1] >= w.min[1] && p[1] <= w.max[1] && p[2] >= w.min[2] && p[2] <= w.max[2]
    for (const w of this.walls) {
      if (inside([origin.x, origin.y, origin.z], w) || inside(hit, w)) continue
      const t = rayBoxAABB(origin, dir, w.min, w.max)
      if (t !== null && t > 1e-3 && t < tHit - 1e-3) return true
    }
    return false
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
    // §16.12: платформы лифтов — плавный спуск к target-Y; крышка проёма
    // закрывается, как только платформа ушла на 1F (targetY ≈ 1)
    for (const l of this.lifts.values()) {
      const dy = l.targetY - l.curY
      if (Math.abs(dy) >= 0.005) {
        const step = Math.sign(dy) * Math.min(Math.abs(dy), 3.2 * dtSec)
        l.curY += step
        for (const m of l.parts) m.position.y = l.curY
      }
      l.cap.isVisible = l.targetY <= 1.01
    }
    // PHYSAFE: меш плавно догоняет снап-цель (носитель ходит, сейф с ним)
    const pf = this.physafePos
    const cur = this.physafeCur
    if (pf !== null && cur !== null && this.physafeParts.length > 0) {
      const dx = pf.x - cur.x
      const dy = pf.y - cur.y
      const dz = pf.z - cur.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist > 0.02) {
        const k = Math.min(1, dist * 10 * dtSec)
        cur.x += dx * k
        cur.y += dy * k
        cur.z += dz * k
        for (const m of this.physafeParts) m.position.addInPlaceFromFloats(dx * k, dy * k, dz * k)
        this.rebuildMini() // глиф миникарты движется вместе с сейфом
      }
    }
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

  /** Цель jack-in-подсказки (GDD §12.1 «дорогой вход», ревебр owner §15.12).
   *  Честные очереди:
   *  1) точка входа в своём радиусе — minby чистой дистанции, как серверный
   *     jackTarget (cyber.go): «SPACE — ДЖЕК-ИН» не врёт о цели;
   *  2) ни одной в радиусе — та, в которую СМОТРИМ (dir по XZ, cos ≥ 0.2
   *     ≈ 78°, за спиной не подсказываем; при равных углах — ближе по d/range):
   *     отвернулся от радио — подсказка тут же про терминал, а не про то, что
   *     осталось за спиной;
   *  3) в конусе взгляда пусто — ближайшая по d/range (прежнее поведение);
   *  4) точек входа на карте нет вовсе — порт прочего устройства в 2 м
   *     (§12.1 «дорогой вход», канал 6 с). */
  /** §16.7: ближайшая клавиатура замка в том же этаже — space у неё
   *  открывает пад кода вместо джек-ина. */
  nearestKeypad(x: number, z: number, playerY?: number): { door: string; id: string; dist: number } | null {
    const eyeY = (playerY ?? 0) + 1.6
    let best: { door: string; id: string; dist: number } | null = null
    for (const k of this.codeDoors.values()) {
      if (Math.abs(k.y + 1.3 - eyeY) > 2.6) continue
      const dist = Math.hypot(k.x - x, k.z - z)
      if (best === null || dist < best.dist) best = { door: k.door, id: k.id, dist }
    }
    return best
  }

  nearestJackPoint(
    x: number,
    z: number,
    dir?: { x: number; y: number; z: number },
    playerY?: number,
  ): { id: string; label: string; dist: number; range: number } | null {
    // §12.1, плейтест 2026-11-17 («в комнате только D1/D2, а хинт — D3»):
    // цель — только УСТРОЙСТВА ТОГО ЖЕ ЭТАЖА: центр порта не дальше 2.6 м
    // по вертикали от глаз (взгляд сквозь перекрытие не джекает).
    const eyeY = (playerY ?? 0) + 1.6
    const sameFloor = (ty: number): boolean => Math.abs(ty - eyeY) <= 2.6
    type P = { id: string; label: string; dist: number; range: number; dx: number; dz: number; ty: number }
    const pts: P[] = []
    // §16.7: клавиатура запертой двери — физический ввод кода (любой класс).
    for (const dc of this.codeDoors.values()) {
      const ty = dc.y + 1.5
      if (!sameFloor(ty)) continue
      pts.push({ id: dc.id, label: `ЗАМОК ${dc.id.toUpperCase()}`, dist: Math.hypot(dc.x - x, dc.z - z), range: TERMINAL_RANGE, dx: dc.x - x, dz: dc.z - z, ty })
    }
    for (const t of this.terminals.values()) {
      const ty = t.y + 1.5
      if (!sameFloor(ty)) continue
      pts.push({ id: t.id, label: `ТЕРМИНАЛ ${t.id.toUpperCase()}`, dist: Math.hypot(t.x - x, t.z - z), range: TERMINAL_RANGE, dx: t.x - x, dz: t.z - z, ty })
    }
    for (const sf of this.safes.values()) {
      const ty = sf.y + 1.2
      if (!sameFloor(ty)) continue
      pts.push({ id: sf.id, label: `NETSAFE ${sf.id.toUpperCase()}`, dist: Math.hypot(sf.x - x, sf.z - z), range: TERMINAL_RANGE, dx: sf.x - x, dz: sf.z - z, ty })
    }
    for (const r of this.radios.values()) {
      const range = r.radius ?? DEFAULT_RADIO_RANGE
      const ty = r.y + 1.5
      if (!sameFloor(ty)) continue
      pts.push({ id: r.id, label: `РАДИО-ТОЧКА ${r.id.toUpperCase()}`, dist: Math.hypot(r.x - x, r.z - z), range, dx: r.x - x, dz: r.z - z, ty })
    }
    // (1) в радиусе — выбор как у серверного jackTarget: при конкуренции
    // портов (камера над проёмом двери) побеждает та, НА КОТОРУЮ СМОТРИМ
    // (конус ~25° по 3D-направлению, dir — полный вектор взгляда камеры);
    // вне конуса — ближайшая (плейтест 2026-11-17: «стоял у D1, а хинт/джек
    // был на CAM3 над проёмом»).
    let nearest: P | null = null
    for (const p of pts) {
      if (p.dist <= p.range && (nearest === null || p.dist < nearest.dist)) nearest = p
    }
    // Кандидаты — ВСЕ порты в радиусе (не один ближайший: дверь и камера
    // над проёмом конкурируют на равных, плейтест 2026-11-17: «смотрю на
    // дверь D1, а джек — КАМЕРА CAM3» — камера была чуть ближе и вытеснила
    // дверь из кандидатов целиком).
    const ports = this.devicePortsInRadius(x, z, playerY)
    const cands: { id: string; label: string; dist: number; range: number; dx: number; dz: number; ty: number }[] = [
      ...pts.filter((p) => p.dist <= p.range),
      ...ports,
    ]
    if (cands.length > 0 && dir !== undefined && (dir.x !== 0 || dir.z !== 0 || dir.y !== 0)) {
      const dl = Math.hypot(dir.x, dir.y, dir.z)
      const ux = dir.x / dl
      const uy = dir.y / dl
      const uz = dir.z / dl
      let aimed: { id: string; label: string; dist: number; range: number } | null = null
      let bestCos = Math.cos((25 * Math.PI) / 180)
      for (const c of cands) {
        const vx = c.dx
        const vy = c.ty - 1.6 // глаза ~1.6 м
        const vz = c.dz
        const vl = Math.hypot(vx, vy, vz)
        if (vl < 0.001) continue
        const cos = (vx * ux + vy * uy + vz * uz) / vl
        if (cos > bestCos) {
          bestCos = cos
          aimed = c
        }
      }
      if (aimed !== null) return aimed
    }
    // вне конуса — ближайший кандидат (в т.ч. порт устройства).
    let candNearest: { id: string; label: string; dist: number; range: number } | null = null
    for (const c of cands) {
      if (candNearest === null || c.dist < candNearest.dist) candNearest = c
    }
    if (candNearest !== null) return candNearest
    if (nearest !== null) return nearest

    if (pts.length > 0) {
      // (3) ни одной в радиусе — куда смотрим: maxcos, tie — d/range.
      if (dir !== undefined && (dir.x !== 0 || dir.z !== 0)) {
        const dl = Math.hypot(dir.x, dir.z)
        const ux = dir.x / dl
        const uz = dir.z / dl
        let gaze: P | null = null
        let bestCos = 0.2
        let bestScore = Number.POSITIVE_INFINITY
        for (const p of pts) {
          const c = (p.dx * ux + p.dz * uz) / Math.max(p.dist, 0.001)
          if (c < bestCos) continue
          const score = p.dist / p.range
          // главный критерий — угол; score только при равных (eps) углах
          if (c > bestCos + 1e-9 || (Math.abs(c - bestCos) <= 1e-9 && score < bestScore)) {
            bestCos = Math.max(bestCos, c)
            bestScore = score
            gaze = p
          }
        }
        if (gaze !== null) return gaze
      }

      // (3) взгляд пуст/не передан — ближайшая по d/range (прежнее §12.1).
      let legacy: P | null = null
      let legacyScore = Number.POSITIVE_INFINITY
      for (const p of pts) {
        if (p.dist / p.range < legacyScore) {
          legacyScore = p.dist / p.range
          legacy = p
        }
      }
      return legacy
    }
    return null
  }

  /** Ближайший порт устройства в 2 м — «дорогой вход» (§12.1, канал 6 с):
   *  свитч/дверь/камера/клапан/газ. Точки входа не участвуют (их радиусы —
   *  свои). */
  private devicePortsInRadius(x: number, z: number, playerY?: number): { id: string; label: string; dist: number; range: number; ty: number; dx: number; dz: number }[] {
    const eyeY = (playerY ?? 0) + 1.6
    // ty — примерная высота порта: нужна для конуса взгляда (камера над
    // проёмом двери — те же x/z, но разные ty, §12.1).
    const out: { id: string; label: string; dist: number; range: number; ty: number; dx: number; dz: number }[] = []
    const kinds: [Map<string, { id: string; x: number; z: number }>, string][] = [
      [this.switches, 'СВИТЧ'],
      [this.doors, 'ДВЕРЬ'],
      [this.cameras, 'КАМЕРА'],
      [this.valves, 'КЛАПАН'],
      [this.gases, 'ГАЗ'],
    ]
    for (const [m, name] of kinds) {
      for (const p of m.values()) {
        const d = Math.hypot(p.x - x, p.z - z)
        if (d <= TERMINAL_RANGE) {
          // высота порта: дверь — середина полотна, клапан/газ — свой y,
          // камера — кронштейн над СВОИМ этажом, остальное — уровнь груди
          let ty = 1.2
          if ('baseY' in p) ty = (p.baseY as number) + 1
          else if ('y' in p) ty = (p.y as number) + 0.6
          else if (name === 'КАМЕРА') ty = 'fy' in p ? (p.fy as number) + 2.6 : 2.6
          // тот же этаж: центр порта не дальше 2.6 м от глаз (D3 сквозь
          // перекрытие не подсказывается, плейтест 2026-11-17)
          if (Math.abs(ty - eyeY) > 2.6) continue
          out.push({ id: p.id, label: `${name} ${p.id.toUpperCase()}`, dist: d, range: TERMINAL_RANGE, ty, dx: p.x - x, dz: p.z - z })
        }
      }
    }
    return out
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

  /** Навигационные точки (§15.14 edge-индикаторы): все сетевые пропсы +
   *  PHYSAFE; y — центр объекта (проекция на экран в main.ts). */
  navTargets(): { id: string; kind: string; x: number; y: number; z: number }[] {
    const out: { id: string; kind: string; x: number; y: number; z: number }[] = []
    for (const t of this.terminals.values()) out.push({ id: t.id, kind: 'terminal', x: t.x, y: t.y + 1, z: t.z })
    for (const r of this.radios.values()) out.push({ id: r.id, kind: 'radio', x: r.x, y: r.y + 1, z: r.z })
    for (const sw of this.switches.values()) out.push({ id: sw.id, kind: 'switch', x: sw.x, y: sw.y + 0.5, z: sw.z })
    for (const d of this.doors.values()) out.push({ id: d.id, kind: 'door', x: d.x, y: d.baseY + d.h / 2, z: d.z })
    for (const c of this.cameras.values()) out.push({ id: c.id, kind: 'camera', x: c.x, y: c.fy, z: c.z })
    for (const g of this.gases.values()) out.push({ id: g.id, kind: 'gas', x: g.x, y: g.y, z: g.z })
    for (const v of this.valves.values()) out.push({ id: v.id, kind: 'valve', x: v.x, y: v.y + 0.5, z: v.z })
    for (const k of this.codeDoors.values()) out.push({ id: k.id, kind: 'keypad', x: k.x, y: k.y + 1.3, z: k.z })
    for (const sf of this.safes.values()) out.push({ id: sf.id, kind: 'safe', x: sf.x, y: sf.y + 0.6, z: sf.z })
    if (this.physafePos !== null) out.push({ id: 'phySafe', kind: 'physafe', x: this.physafePos.x, y: this.physafePos.y + 0.5, z: this.physafePos.z })
    for (const b of this.liftBtns.values()) out.push({ id: b.id, kind: 'liftbtn', x: b.x, y: b.y + 1.1, z: b.z })
    return out
  }

  hostKind(id: string): CyberKind | null {
    if (this.terminals.has(id)) return 'terminal'
    if (this.safes.has(id)) return 'safe'
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
      this.cameras.has(id) || this.gases.has(id) || this.fires.has(id) || this.valves.has(id) || this.safes.has(id) ||
      (id === 'physafe' && this.physafePos !== null)
  }

  private rebuildMini(): void {
    const out: MiniProp[] = []
    for (const t of this.terminals.values()) out.push({ x: t.x, z: t.z, kind: 'terminal' })
    for (const sf of this.safes.values()) out.push({ x: sf.x, z: sf.z, kind: 'safe' })
    if (this.physafePos !== null) out.push({ x: this.physafePos.x, z: this.physafePos.z, kind: 'physafe' })
    for (const b of this.liftBtns.values()) out.push({ x: b.x, z: b.z, kind: 'liftbtn' })
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
