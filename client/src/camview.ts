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
  owner: number | null
}

/** Точка рендера — не в креплении, а вынесена вдоль взгляда (плейтест
 *  2026-11-20 «картинка с камеры — красное полотно и зелёный купол»: из
 *  точки крепления объектив упирался в стену и собственный корпус). 0.9 м —
 *  за габарит корпуса (0.42 м) с запасом; +0.12 вверх — над корпусом. */
const CAM_OFFSET = 0.9
const CAM_LIFT = 0.12

export class CamView {
  readonly camera: FreeCamera
  /** Открыт ли вид камеры в meatview (fullscreen-подмена основной картинки). */
  active = false
  /** Индекс текущей камеры в списке союзных (цикл V/тап). */
  private idx = 0
  private list: CamInfo[] = []
  /** Занят ли кадр табом камеры в hackview (рендер в панель, не на весь экран). */
  private panel: HTMLCanvasElement | null = null
  /** Колбэк «вид камеры открылся/закрылся/сменился» — main перерисовывает оверлей. */
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
      if (this.active || this.panel !== null) this.close()
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

  /** Открыть вид в панели hackview (таб камеры) — без подмены основной картинки. */
  attachPanel(canvas: HTMLCanvasElement, camId?: string): void {
    this.panel = canvas
    if (camId !== undefined) {
      const i = this.list.findIndex((c) => c.id === camId)
      if (i >= 0) this.idx = i
    }
    this.apply()
    this.onChange?.()
  }

  detachPanel(): void {
    if (this.panel === null) return
    this.panel = null
    this.onChange?.()
  }

  /** Есть ли что рендерить: fullscreen-вид или панель таба. */
  get visible(): boolean {
    return this.active || this.panel !== null
  }

  /** Панель активна — рендер этой камерой нужен только чтобы блитить кадр. */
  get panelCanvas(): HTMLCanvasElement | null {
    return this.panel
  }

  close(): void {
    if (!this.active && this.panel === null) return
    this.active = false
    this.panel = null
    this.onChange?.()
  }

  /** Обновить позицию/ориентацию камеры из текущего выбора (каждый кадр/смена). */
  apply(): void {
    const c = this.current()
    if (c === null) return
    // Вынос точки рендера вдоль взгляда (см. CAM_OFFSET): из самого крепления
    // кадр — стена/корпус, плейтест 2026-11-20.
    const fx = Math.sin(c.yaw)
    const fz = Math.cos(c.yaw)
    this.camera.position.set(c.x + fx * CAM_OFFSET, c.y + CAM_LIFT, c.z + fz * CAM_OFFSET)
    // Babylon rotation.x — вниз-положительный; pitch карты — вверх-положительный.
    this.camera.rotation.set(-c.pitch, c.yaw, 0)
  }

  /** Поза точки рендера — та же, что ставит apply(): нужна hackview для
   *  проекции меток целей на кадр (тег рисуем поверх canvas, §13.7). id —
   *  какой именно камеры поза (в таб идёт только она, сверяться с ref.dev). */
  pose(): { id: string; x: number; y: number; z: number; yaw: number; pitch: number; fov: number } | null {
    const c = this.current()
    if (c === null) return null
    const fx = Math.sin(c.yaw)
    const fz = Math.cos(c.yaw)
    return {
      id: c.id,
      x: c.x + fx * CAM_OFFSET,
      y: c.y + CAM_LIFT,
      z: c.z + fz * CAM_OFFSET,
      yaw: c.yaw,
      pitch: c.pitch,
      fov: this.camera.fov,
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
