// Skeleton scene: a Babylon.js viewport whose only job is to prove that
// render + WebSocket pipeline work end to end. The spinning "server rack"
// is driven by the authoritative server tick, so if it stops spinning the
// network is broken, not the render loop.

import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'

import { GameSocket, type NetStats } from './net'

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement

const engine = new Engine(canvas, true)
const scene = new Scene(engine)
scene.clearColor = new Color4(0.02, 0.04, 0.025, 1)

const camera = new UniversalCamera('camera', new Vector3(6, 4, -6), scene)
camera.setTarget(Vector3.Zero())
camera.attachControl(canvas, true)
camera.inputs.removeByType('FreeCameraKeyboardMoveInput')

const light = new HemisphericLight('light', new Vector3(0, 1, 0), scene)
light.intensity = 0.7

// Wireframe grid floor: cheap placeholder "level".
const ground = MeshBuilder.CreateGround('ground', { width: 24, height: 24 }, scene)
const groundMat = new StandardMaterial('groundMat', scene)
groundMat.wireframe = true
groundMat.diffuseColor = new Color3(0.1, 0.7, 0.35)
groundMat.emissiveColor = new Color3(0.02, 0.25, 0.1)
ground.material = groundMat

// The "server rack": rotation is set from the server tick in the HUD update,
// making snapshot flow visible without any instrumentation.
const rack = MeshBuilder.CreateBox('rack', { width: 1, height: 2.2, depth: 1 }, scene)
rack.position.y = 1.1
const rackMat = new StandardMaterial('rackMat', scene)
rackMat.diffuseColor = new Color3(0.05, 0.15, 0.1)
rackMat.emissiveColor = new Color3(0, 0.55, 0.25)
rack.material = rackMat

// ---- HUD wiring ----

const el = {
  status: document.getElementById('status')!,
  tick: document.getElementById('tick')!,
  players: document.getElementById('players')!,
  rtt: document.getElementById('rtt')!,
  snaps: document.getElementById('snaps')!,
}

function renderHud(stats: NetStats): void {
  const label = { connecting: 'CONNECTING…', open: 'ONLINE', closed: 'OFFLINE' }[stats.status]
  el.status.textContent = label
  el.status.className = `status-${stats.status}`
  el.tick.textContent = stats.tick > 0 ? String(stats.tick) : '—'
  el.players.textContent = stats.players > 0 ? String(stats.players) : '—'
  el.rtt.textContent = stats.rttMs !== null ? `${stats.rttMs} ms` : '—'
  el.snaps.textContent = stats.snapsPerSec > 0 ? String(stats.snapsPerSec) : '—'
  rack.rotation.y = stats.tick * 0.02
}

const sock = new GameSocket(renderHud)
sock.start()

engine.runRenderLoop(() => {
  scene.render()
})

window.addEventListener('resize', () => {
  engine.resize()
})
