// Живой вид камер (§13.7): вторая FreeCamera в той же сцене — V в meatview
// подменяет картинку камерой союзника, цикл по id, ESC закрывает. Таб камеры
// в hackview рендерит тот же вид в свой canvas (blit из рендер-канваса).
// Вращение камер — M6; здесь только статичный взгляд из данных карты.

import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'
import { CAM_PROP_LAYER } from './props'

export interface CamInfo {
  id: string
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  patrol: boolean
  owner: number | null
}

/** Точка рендера — не в креплении, а вынесена вдоль взгляда (плейтест
 *  2026-11-20 «картинка с камеры — красное полотно и зелёный купол»: из
 *  точки крепления объектив упирался в стену и собственный корпус). 0.9 м —
 *  за габарит корпуса (0.42 м) с запасом; +0.12 вверх — над корпусом. */
const CAM_OFFSET = 0.9
const CAM_LIFT = 0.12
/** Ручной поворот в V-режиме: 15% чувствительности тела (плейтест 2026-11-20
 *  «вращение по mlook, но достаточно медленное — хоть в стену направь»). */
/** Поворот камеры — прямой джойстик для ОБЕИХ путей (владелец 2026-11-20:
 *  «drag был кривой, v-mlook тоже можно быстрый»): 1000 px ≈ 286°. */
const CAM_LOOK_SENS = 0.005
const CAM_DRAG_SENS = CAM_LOOK_SENS
const CAM_PITCH_LIMIT = 1.3
/** Базовый fov объектива; зум — делитель (1× = база, 3× = телевик). */
const CAM_BASE_FOV = 1.0
const CAM_ZOOM_MIN = 1
const CAM_ZOOM_MAX = 3

export class CamView {
  readonly camera: FreeCamera
  /** Открыт ли вид камеры в meatview (fullscreen-подмена основной картинки). */
  active = false
  /** Индекс текущей камеры в списке союзных (цикл V/тап). */
  private idx = 0
  private list: CamInfo[] = []
  /** Ручной доворот в V-режиме по id камеры (mlook, §13.7): сверх базовых
   *  yaw/pitch карты; живёт, пока открыта дека/вид, сброс — close(). */
  private pans = new Map<string, { yaw: number; pitch: number }>()
  /** Панели живого кадра в табах камер hackview (сплит H/V: несколько одновременно).
   *  Рендер — в этой же камере (одна сцена), main блитит canvas за canvas;
   *  2 Гц — совпадает с «КАДР 2 Гц» ленты и дешевле per-frame. */
  private panels = new Map<string, HTMLCanvasElement[]>()
  /** Колбэк «вид камеры открылся/закрылся/сменился» — main перерисовывает оверлей. */
  /** §13.7 M6: слать доворот на сервер (main подключает sock.sendCamrot).
   *  Local-pan — только echo: картинка крутится без задержки, сервер —
   *  истина (переживает закрытие, видна союзникам, двигает конус). */
  sendCamrot: ((dev: string, yaw: number, pitch: number) => void) | null = null
  /** Echo-довороты: pan живёт 500 мс после последнего движения — дальше
   *  побеждает серверный yaw из снапа (патруль/чужой доворот). */
  private lastRotAt = new Map<string, number>()
  private lastSentAt = 0
  private pendingSend: ReturnType<typeof setTimeout> | null = null
  /** Оптический зум по камере (1..3) — клиентская оптика монитора: серверный
   *  конус сенсора не меняется (картинка всегда Ų конуса, не шире). */
  private zooms = new Map<string, number>()
  onChange: (() => void) | null = null

  constructor(scene: Scene) {
    this.camera = new FreeCamera('camview', new Vector3(0, 2, 0), scene)
    // minZ за габарит корпуса: ближняя геометрия не «в лицо» (стена после
    // выноса всё ещё в 0.1 м — был бы занавес, плейтест 2026-11-20)
    this.camera.minZ = 0.2
    this.camera.maxZ = 400
    this.camera.fov = 1.0 // уже, чем у игрока: камера — «телевик» наблюдения
    this.camera.rotation.set(0, 0, 0)
    // кулинг собственного корпуса: слой CAM_PROP вырезан из вида
    this.camera.layerMask = 0x0fffffff & ~CAM_PROP_LAYER
  }

  /** Текущая камера (для подписи оверлея) или null. */
  current(): CamInfo | null {
    return this.list.length > 0 ? this.list[this.idx % this.list.length] : null
  }

  hasCameras(): boolean {
    return this.list.length > 0
  }

  /** Список доступных камер обновляется из снапшотов (владение меняется). */
  setCameras(cams: readonly CamInfo[], usable: (owner: number | null) => boolean): void {
    const prevId = this.current()?.id
    this.list = cams.filter((c) => usable(c.owner))
    // Держимся за ту же камеру при пересборке списка (владение могло смениться).
    if (prevId !== null) {
      const i = this.list.findIndex((c) => c.id === prevId)
      if (i >= 0) this.idx = i
    }
    if (this.list.length === 0) {
      if (this.active || this.panels.size > 0) this.close()
      return
    }
    if (this.idx >= this.list.length) this.idx = 0
    this.apply()
  }

  /** V / тап: открыть вид камеры, а если уже открыт — следующая камера. */
  toggle(): void {
    if (this.list.length === 0) return
    if (!this.active) {
      this.active = true
      this.idx %= this.list.length
      this.apply()
      this.onChange?.()
      return
    }
    this.next()
  }

  next(): void {
    if (this.list.length === 0) return
    this.idx = (this.idx + 1) % this.list.length
    this.apply()
    this.onChange?.()
  }

  prev(): void {
    if (this.list.length === 0) return
    this.idx = (this.idx - 1 + this.list.length) % this.list.length
    this.apply()
    this.onChange?.()
  }

  /** Открыть вид в панели hackview (таб камеры) — без подмены основной картинки.
   *  Сплит: у каждого таба своя панель, attach по id камеры. */
  attachPanel(canvas: HTMLCanvasElement, camId?: string): void {
    const first = this.panels.size === 0
    if (camId !== undefined) {
      const arr = this.panels.get(camId)
      if (arr !== undefined) arr.push(canvas)
      else this.panels.set(camId, [canvas])
      // индекс — на ПЕРВОЙ прикрепленной панели: V-цикл стартует с неё,
      // сплит с 2+ камерами не должен гонять fullscreen по списку
      if (first) {
        const i = this.list.findIndex((c) => c.id === camId)
        if (i >= 0) this.idx = i
        this.apply()
      }
    }
    this.onChange?.()
  }

  detachPanel(camId?: string): void {
    if (camId !== undefined) this.panels.delete(camId)
    else this.panels.clear()
    if (this.panels.size === 0) this.onChange?.()
  }

  /** Панели для 2 Гц блита (id камеры → canvases; сплит: два таба одной камеры). */
  get visiblePanels(): ReadonlyMap<string, HTMLCanvasElement[]> {
    return this.panels
  }

  /** Поставить объектив на конкретную камеру (из visiblePanels) — 2 Гц pump
   *  в main переключает позы между блитами панелей. false — камеры нет. */
  applyFor(camId: string): boolean {
    const c = this.list.find((k) => k.id === camId)
    if (c === undefined) return false
    const yaw = this.yawOf(c)
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    this.camera.position.set(c.x + fx * CAM_OFFSET, c.y + CAM_LIFT, c.z + fz * CAM_OFFSET)
    this.camera.rotation.set(-this.pitchOf(c), yaw, 0)
    this.camera.fov = this.fovOf(camId)
    return true
  }

  /** Есть ли что рендерить: fullscreen-вид или панели таба. */
  get visible(): boolean {
    return this.active || this.panels.size > 0
  }

  close(): void {
    if (!this.active && this.panels.size === 0) return
    this.active = false
    this.panels.clear()
    this.pans.clear() // ручной доворот не переживает закрытие вьюхи (как зум карты §12.6)
    this.zooms.clear()
    this.onChange?.()
  }

  private yawOf(c: CamInfo): number {
    this.expirePan(c.id)
    return this.pans.get(c.id)?.yaw ?? c.yaw
  }

  private pitchOf(c: CamInfo): number {
    this.expirePan(c.id)
    return this.pans.get(c.id)?.pitch ?? c.pitch
  }

  /** Echo устарел — серверный yaw из снапа снова главный. */
  private expirePan(id: string): void {
    const at = this.lastRotAt.get(id)
    if (at !== undefined && performance.now() - at > 500) {
      this.pans.delete(id)
      this.lastRotAt.delete(id)
    }
  }

  /** Медленный поворот ТЕКУЩЕЙ камеры мышью/тач-кругом в V-режиме (d — px). */
  rotate(dxPx: number, dyPx: number): void {
    const c = this.current()
    if (c === null) return
    this.rotateDev(c.id, dxPx, dyPx, CAM_LOOK_SENS)
  }

  /** Поворот КОНКРЕТНОЙ камеры (V — текущей, drag по кадру в деке — своей).
   *  sens: V-mlook — 15% от телесной, drag — прямой джойстик (в 15× резче). */
  rotateDev(camId: string, dxPx: number, dyPx: number, sens = CAM_DRAG_SENS): void {
    const c = this.list.find((k) => k.id === camId)
    if (c === undefined) return
    const cur = this.pans.get(camId) ?? { yaw: c.yaw, pitch: c.pitch }
    cur.yaw += dxPx * sens
    cur.pitch = Math.max(-CAM_PITCH_LIMIT, Math.min(CAM_PITCH_LIMIT, cur.pitch - dyPx * sens))
    if (cur.yaw > Math.PI) cur.yaw -= 2 * Math.PI
    else if (cur.yaw < -Math.PI) cur.yaw += 2 * Math.PI
    this.pans.set(camId, cur)
    this.lastRotAt.set(camId, performance.now())
    this.shipCamrot(c)
  }

  /** camrot на сервер: не чаще 20 Гц + хвостовой досыл последнего значения. */
  private shipCamrot(c: CamInfo): void {
    if (this.sendCamrot === null) return
    const pan = this.pans.get(c.id)
    if (pan === undefined) return
    const now = performance.now()
    if (now - this.lastSentAt >= 50) {
      this.lastSentAt = now
      if (this.pendingSend !== null) {
        clearTimeout(this.pendingSend)
        this.pendingSend = null
      }
      this.sendCamrot(c.id, pan.yaw, pan.pitch)
      return
    }
    if (this.pendingSend === null) {
      this.pendingSend = setTimeout(() => {
        this.pendingSend = null
        const p = this.pans.get(c.id)
        if (p !== undefined && this.sendCamrot !== null) this.sendCamrot(c.id, p.yaw, p.pitch)
      }, 50 - (now - this.lastSentAt))
    }
  }

  /** Зум конкретной камеры (для пинча: стартовое значение). */
  zoomOf(camId: string): number {
    return this.zooms.get(camId) ?? 1
  }

  /** Множитель зума (колесо/пинч/кнопки); кламп 1..3. Возвращает итог. */
  zoomBy(camId: string, mult: number): number {
    const c = this.list.find((k) => k.id === camId)
    if (c === undefined) return this.zoomOf(camId)
    const z = Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, this.zoomOf(camId) * mult))
    this.zooms.set(camId, z)
    this.apply()
    this.onChange?.()
    return z
  }

  private fovOf(camId: string): number {
    return CAM_BASE_FOV / this.zoomOf(camId)
  }

  /** Задать зум напрямую (пинч: абсолютное значение). */
  zoomSet(camId: string, z: number): void {
    const c = this.list.find((k) => k.id === camId)
    if (c === undefined) return
    this.zooms.set(camId, Math.max(CAM_ZOOM_MIN, Math.min(CAM_ZOOM_MAX, z)))
    this.apply()
  }

  /** Обновить позицию/ориентацию камеры из текущего выбора (каждый кадр/смена). */
  apply(): void {
    const c = this.current()
    if (c === null) return
    // Вынос точки рендера вдоль взгляда (см. CAM_OFFSET): из самого крепления
    // кадр — стена/корпус, плейтест 2026-11-20.
    const yaw = this.yawOf(c)
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    this.camera.position.set(c.x + fx * CAM_OFFSET, c.y + CAM_LIFT, c.z + fz * CAM_OFFSET)
    // Babylon rotation.x — вниз-положительный; pitch карты — вверх-положительный.
    this.camera.rotation.set(-this.pitchOf(c), yaw, 0)
    this.camera.fov = this.fovOf(c.id)
  }

  /** Поза точки рендера КАЖДОЙ камеры — hackview проектирует теги целей по
   *  своей (ref.dev), не по «текущей»: сплит с 2+ панелями (§13.7). */
  poseOf(camId: string): { id: string; x: number; y: number; z: number; yaw: number; pitch: number; fov: number } | null {
    const c = this.list.find((k) => k.id === camId)
    // (см. applyFor — та же формула)
    if (c === undefined) return null
    const yaw = this.yawOf(c)
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    return {
      id: c.id,
      x: c.x + fx * CAM_OFFSET,
      y: c.y + CAM_LIFT,
      z: c.z + fz * CAM_OFFSET,
      yaw,
      pitch: this.pitchOf(c),
      fov: this.fovOf(c.id),
    }
  }

  /** Тап по живому кадру в деке → meatview-подмена этим кадром (mobile). */
  openFullscreen(): void {
    if (this.list.length === 0) return
    this.active = true
    this.apply()
    this.onChange?.()
  }

  /** Открыть fullscreen-вид КОНКРЕТНОЙ камеры (тап по кадру таба деки). */
  openFor(camId: string): void {
    const i = this.list.findIndex((c) => c.id === camId)
    if (i < 0) return
    this.idx = i
    this.openFullscreen()
  }

  /** Какая камера рендерится сейчас — id или null. */
  get currentId(): string | null {
    return this.current()?.id ?? null
  }
}
