// Basic scene rig: dark cyberpunk void, fog for depth, one fully manual
// camera (controls.ts owns rotation, snapshot interpolation owns position).

import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { Engine } from '@babylonjs/core/Engines/engine'

export interface SceneRig {
  scene: Scene
  camera: FreeCamera
}

export function createScene(engine: Engine): SceneRig {
  const scene = new Scene(engine)
  const voidColor = new Color3(0.012, 0.022, 0.016)
  scene.clearColor = new Color4(voidColor.r, voidColor.g, voidColor.b, 1)
  scene.fogMode = Scene.FOGMODE_EXP2
  scene.fogColor = voidColor
  scene.fogDensity = 0.02

  // attachControl is deliberately NOT called: rotation comes from
  // controls.ts, position from snapshot interpolation (no prediction, GDD §9.1).
  const camera = new FreeCamera('fps', new Vector3(0, 2, 0), scene)
  camera.minZ = 0.05
  camera.maxZ = 400
  camera.fov = 1.15
  camera.rotation.set(0, 0, 0)

  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  hemi.intensity = 0.55
  hemi.diffuse = new Color3(0.5, 0.9, 0.7)
  hemi.groundColor = new Color3(0.05, 0.08, 0.07)

  const dir = new DirectionalLight('dir', new Vector3(-0.35, -1, -0.25), scene)
  dir.intensity = 0.35
  dir.diffuse = new Color3(0.55, 0.75, 0.65)

  return { scene, camera }
}
