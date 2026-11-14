// E2E smoke: поднимает ВЫДЕЛЕННЫЙ чистый сервер (go run) на свободном порту и
// прогоняет весь конвейер: HTTP → карту → протокол → движение → прицельный
// огонь до убийства → респаун → авто-ребаланс. Против внешнего стенда:
// BASE_URL=http://127.0.0.1:9999 node scripts/e2e_smoke.mjs (комната должна
// быть пустой — иначе баланс/ребаланс недетерминированы).
// Запуск: node scripts/e2e_smoke.mjs   (нужен go в PATH)

import { spawn } from 'node:child_process'

let BASE = process.env.BASE_URL
let ownServer = null

if (!BASE) {
  const port = 18000 + Math.floor(Math.random() * 2000)
  BASE = `http://127.0.0.1:${port}`
  ownServer = spawn('go', ['run', '.', '-addr', `127.0.0.1:${port}`], {
    cwd: new URL('../server', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownServer.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`))
  process.on('exit', () => ownServer.kill())
  process.on('SIGINT', () => { ownServer.kill(); process.exit(130) })
  // ждём healthz
  const t0 = Date.now()
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) break
    } catch { /* ещё не слушает */ }
    if (Date.now() - t0 > 30000) { console.error('FAIL — сервер не поднялся за 30 с'); ownServer.kill(); process.exit(1) }
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`выделенный сервер: ${BASE}`)
}

const WS = BASE.replace(/^http/, 'ws') + '/ws'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1. HTTP: healthz + карта ---
const health = await (await fetch(`${BASE}/healthz`)).json()
check('GET /healthz', health.status === 'ok')
const map = await (await fetch(`${BASE}/api/map`)).json()
check(
  'GET /api/map',
  Array.isArray(map.colliders) && map.colliders.length > 20 &&
    map.spawns['0'].length >= 4 && map.spawns['1'].length >= 4,
  `colliders=${map.colliders.length}`,
)

// --- клиенты ---
function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS)
    const c = { ws, msgs: [], name: '' }
    ws.onopen = () => res(c)
    ws.onerror = rej
    ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data))
  })
}
const send = (c, m) => c.ws.send(JSON.stringify(m))
const welcome = (c) => c.msgs.find((m) => m.t === 'welcome')
const lastSnap = (c) => [...c.msgs].reverse().find((m) => m.t === 'snap')
const me = (c) => {
  const w = welcome(c)
  return lastSnap(c)?.players.find((p) => p.id === w.id)
}
const waitFor = (c, pred, ms = 4000) =>
  new Promise((res, rej) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const m = c.msgs.find(pred)
      if (m) { clearInterval(iv); res(m) }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')) }
    }, 25)
  })

// --- 2. join 4 → 2v2 ---
const clients = []
for (let i = 0; i < 4; i++) {
  const c = await connect()
  c.name = `E2E_${i + 1}`
  clients.push(c)
  send(c, { t: 'join', name: c.name, cls: 'assault' })
}
await sleep(600)
const teams = clients.map((c) => welcome(c)?.team)
check('join: 4 welcome, ровно 2v2', teams.every((t) => t !== undefined) && teams.filter((t) => t === 0).length === 2, teams.join(','))
const sameTeamPair = clients.filter((c) => welcome(c).team === 1) // жертва и стрелок в одной команде (FF ON)
const [victim, shooter] = sameTeamPair
check('одна команда у пары FF-теста', welcome(victim).team === welcome(shooter).team)

// --- 3. движение ---
const mover = clients.find((c) => c !== victim && c !== shooter)
const before = { ...me(mover) }
for (let i = 0; i < 30; i++) {
  send(mover, { t: 'input', seq: i + 1, keys: { w: 1, a: 0, s: 0, d: 0, interact: 0 }, yaw: 0, pitch: 0 })
  await sleep(33)
}
await sleep(200)
const after = me(mover)
const moved = Math.hypot(after.x - before.x, after.z - before.z)
check('движение (W 1 c) > 1 м', moved > 1, `Δ=${moved.toFixed(2)} м`)

// --- 4. прицельный огонь до убийства (главный тест) ---
const aimAt = (fromP, toP, aimY) => {
  const eye = { x: fromP.x, y: fromP.y + 1.6, z: fromP.z }
  const dx = toP.x - eye.x, dy = aimY - eye.y, dz = toP.z - eye.z
  const h = Math.hypot(dx, dz)
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, h) }
}
// Если пара заспавнилась в одной точке — развести жертву на пару метров.
{
  const s = me(shooter), v = me(victim)
  if (Math.hypot(v.x - s.x, v.z - s.z) < 2) {
    for (let i = 0; i < 20; i++) {
      send(victim, { t: 'input', seq: i + 1, keys: { w: 1, a: 0, s: 0, d: 0, interact: 0 }, yaw: Math.PI / 2, pitch: 0 })
      await sleep(33)
    }
    await sleep(300)
  }
}
const s0 = me(shooter), v0 = me(victim)
const dist = Math.hypot(v0.x - s0.x, v0.z - s0.z)
console.log(`  дистанция пары: ${dist.toFixed(1)} м`)
let shotsFired = 0
let death = null
// AR: 10 урона, 125 HP → 13 попаданий; стреляем в грудь до смерти (макс 25 выстрелов)
for (let i = 0; i < 25 && !death; i++) {
  const s = me(shooter), v = me(victim)
  if (!v.alive) break
  const { yaw, pitch } = aimAt(s, v, v.y + 1.3)
  send(shooter, { t: 'fire', yaw, pitch })
  shotsFired++
  await sleep(150)
  death = victim.msgs.find((m) => m.t === 'death')
}
const hits = shooter.msgs.filter((m) => m.t === 'shot' && m.hit === welcome(victim).id).length
check('убийство Friendly-Fire-пары (AR ~13 попаданий)', !!death, `выстрелов=${shotsFired}, попаданий=${hits}`)
check('снапшоты: жертва alive=false', me(shooter).alive === false || lastSnap(shooter).players.find((p) => p.id === welcome(victim).id).alive === false)
check('очки команде стрелка', lastSnap(shooter).scores[welcome(shooter).team] >= 1, lastSnap(shooter).scores.join(':'))

// --- 5. респаун + смена класса ---
await sleep(5500) // respawn-таймер 5 c + запас на детект смерти
send(victim, { t: 'respawn', cls: 'sniper' })
await sleep(400)
const vNew = me(victim)
check('респаун со сменой класса на sniper', vNew.alive === true && vNew.cls === 'sniper', `hp=${vNew.hp}`)

// --- 6. авто-ребаланс: уходит одна команда → оставшаяся пара делится ---
const team0 = clients.filter((c) => welcome(c).team === 0)
team0.forEach((c) => c.ws.close())
try {
  const teamMsg = await waitFor(
    shooter,
    (m) => m.t === 'team',
    4000,
  )
  check('ребаланс: пришло {t:team}', teamMsg.team !== welcome(shooter).team, `team=${teamMsg.team}`)
} catch {
  check('ребаланс: пришло {t:team}', false, 'timeout')
}
await sleep(300)
const remaining = clients.filter((c) => c.ws.readyState === 1).map((c) => lastSnap(c).players.find((p) => p.id === welcome(c).id).team)
check('после ухода 2v0 → 1v1', new Set(remaining).size === remaining.length, remaining.join(','))

// --- 7. одинаковые имена получают суффикс, выбор команды уважается ---
{
  const x = await connect()
  const y = await connect()
  x.ws.send(JSON.stringify({ t: 'join', name: 'Doppel', cls: 'assault', team: 0 }))
  y.ws.send(JSON.stringify({ t: 'join', name: 'Doppel', cls: 'assault', team: 1 }))
  const wx = await waitFor(x, (m) => m.t === 'welcome')
  const wy = await waitFor(y, (m) => m.t === 'welcome')
  check('join с выбором команды уважается', wx.team === 0 && wy.team === 1, `${wx.team}/${wy.team}`)
  await sleep(400)
  const names = lastSnap(x).players.filter((p) => p.name.startsWith('Doppel')).map((p) => p.name)
  check('дубликат имени получает суффикс -2', names.length === 2 && new Set(names).size === 2, names.join(' & '))
  x.ws.close()
  y.ws.close()
}

clients.forEach((c) => c.ws.readyState === 1 && c.ws.close())
console.log(failures === 0 ? '\nE2E: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓' : `\nE2E: ПРОВАЛОВ ${failures}`)
process.exit(failures === 0 ? 0 : 1)
