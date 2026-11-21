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
  // 4-й (shooter FF-пары) — снайпер: ваншот-тест §3.3
  send(c, { t: 'join', name: c.name, cls: i === 3 ? 'sniper' : 'assault' })
}
await sleep(600)
const teams = clients.map((c) => welcome(c)?.team)
check('join: 4 welcome, ровно 2v2', teams.every((t) => t !== undefined) && teams.filter((t) => t === 0).length === 2, teams.join(','))
const sameTeamPair = clients.filter((c) => welcome(c).team === 1) // жертва и стрелок в одной команде (FF ON)
const [victim, shooter] = sameTeamPair
check('одна команда у пары FF-теста', welcome(victim).team === welcome(shooter).team)
// стрелок — снайпер: 150 урона, ваншот всех кроме heavy (ГДД §3.3)

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
// Снайпер: 1 прицельный выстрел в грудь = смерть (150 ≥ 125)
for (let i = 0; i < 3 && !death; i++) {
  const s = me(shooter), v = me(victim)
  if (!v.alive) break
  const { yaw, pitch } = aimAt(s, v, v.y + 1.3)
  send(shooter, { t: 'fire', yaw, pitch })
  shotsFired++
  await sleep(150)
  death = victim.msgs.find((m) => m.t === 'death')
}
const hits = shooter.msgs.filter((m) => m.t === 'shot' && m.hit === welcome(victim).id).length
check('ваншот снайпера по автоматчику', !!death && shotsFired === 1, `выстрелов=${shotsFired}, попаданий=${hits}`)
check('снапшоты: жертва alive=false', me(shooter).alive === false || lastSnap(shooter).players.find((p) => p.id === welcome(victim).id).alive === false)
check('очки команде стрелка', lastSnap(shooter).scores[welcome(shooter).team] >= 1, lastSnap(shooter).scores.join(':'))

// --- 5. респаун + смена класса ---
await sleep(5500) // respawn-таймер 5 c + запас на детект смерти
send(victim, { t: 'respawn', cls: 'heavy' })
await sleep(400)
const vNew = me(victim)
check('респаун со сменой класса на heavy', vNew.alive === true && vNew.cls === 'heavy', `hp=${vNew.hp}`)

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

// --- 8. M5: данные — джек-ин, сеть, щит SRV, cp, decrypt, codes (§16) ---
// Хайст проверяем хакером от t1: portscan раскрывает сеть, щит SRV1 отбивает
// первые попытки взлома, trojan даёт владение → листинг → cp door_key на
// деку → decrypt на SRV (NPU ×3) → codes.door команде. Замок d3 физически
// (клавиатура на 2F) в e2e не открываем — только denied too_far издалека.
{
  await sleep(300)
  const t1 = map.props.find((p) => p.id === 't1')
  const H = await connect()
  send(H, { t: 'join', name: 'E2E_H', cls: 'hacker', team: 0 })
  const wH = await waitFor(H, (m) => m.t === 'welcome')
  const walkTo = async (c, tx, tz) => {
    for (let i = 0; i < 250; i++) {
      const p = me(c)
      if (!p) { await sleep(50); continue }
      const dx = tx - p.x, dz = tz - p.z
      if (Math.hypot(dx, dz) < 1.5) break
      send(c, { t: 'input', seq: 20000 + i, keys: { w: 1, a: 0, s: 0, d: 0, interact: 0 }, yaw: Math.atan2(dx, dz), pitch: 0 })
      await sleep(33)
    }
  }
  // waitFor ищет по ВСЕМ накопленным сообщениям; здесь нужны только НОВЫЕ
  const waitNew = (c, t, ms = 8000, pred = () => true) => new Promise((res, rej) => {
    const n0 = c.msgs.filter((m) => m.t === t).length
    const t0 = Date.now()
    const iv = setInterval(() => {
      const m = c.msgs.filter((x) => x.t === t).slice(n0).find(pred)
      if (m) { clearInterval(iv); res(m) }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout ${t}`)) }
    }, 50)
  })

  await walkTo(H, t1.pos[0], t1.pos[2])
  for (let i = 0; i < 3; i++) {
    send(H, { t: 'input', seq: 21000 + i, keys: { w: 0, a: 0, s: 0, d: 0, interact: 1 }, yaw: 0, pitch: 0 })
    await sleep(33)
  }
  const jin = await waitFor(H, (m) => m.t === 'jackin', 8000).catch(() => null)
  check('M5: джек-ин в t1', jin?.host === 't1')

  // portscan — туман войны открывает сеть по хопам; сканируем до раскрытия
  // нужных узлов (d3 за свитчом 2F — глубже, чем 3 хопа)
  const seenIDs = () => {
    const s = [...H.msgs].reverse().find((m) => m.t === 'scan')
    return s ? s.devices.map((d) => d.id) : []
  }
  const need = ['srv1', 'netsafe', 'd3']
  for (let i = 0; i < 12 && !need.every((id) => seenIDs().includes(id)); i++) {
    send(H, { t: 'run', prog: 'portscan' })
    // ждать ПОЛНОГО завершения скана (scan шлётся по завершении); посылать
    // следующий поверх работающего нельзя — честные очереди §16.3 делят
    // магистраль между параллельными сканами и раскрытие ползёт
    // (отловлено 2026-11-21: 3 параллельных portscan'а — ETA 30-45 с)
    for (let j = 0; j < 200; j++) {
      const d = [...H.msgs].reverse().find((m) => m.t === 'deck')
      if (d && (d.progs || []).length === 0) break
      await sleep(100)
    }
    await sleep(200)
  }
  const ids = seenIDs()
  check('M5: portscan раскрыл SRV1/NETSAFE/d3', need.every((id) => ids.includes(id)), `раскрыто ${ids.length} устройств`)

  // дать портсканам завершиться — иначе слоты RAM заняты и следующий запуск
  // получит ram_full вместо честной попытки
  const progsIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const d = [...H.msgs].reverse().find((m) => m.t === 'deck')
      if (d && (d.progs || []).length === 0) return
      await sleep(100)
    }
  }
  await progsIdle()

  // щит SRV (§16.5): первые попытки взлома отбиваются, заряд тратится
  let shields = 0
  const tryProg = async (prog, dev) => {
    send(H, { t: 'run', prog, dev })
    const d = await waitNew(H, 'denied', 900, (m) => m.reason === 'shield').catch(() => null)
    if (d) { shields++; return false }
    return true
  }
  let started = false
  for (let i = 0; i < 4 && !started; i++) started = await tryProg('vulnscan', 'srv1')
  await sleep(3400)
  const srvVulned = [...H.msgs].reverse().find((m) => m.t === 'scan')?.devices.find((d) => d.id === 'srv1')?.vulned
  check('M5: щит SRV1 отбил 3 попытки, затем vulnscan прошёл', shields === 3 && srvVulned === true, `отбоев=${shields}`)

  send(H, { t: 'run', prog: 'trojan', dev: 'srv1' })
  await sleep(2600)
  const srvDev = [...H.msgs].reverse().find((m) => m.t === 'scan')?.devices.find((d) => d.id === 'srv1')
  const key = srvDev?.data?.[0]?.n
  check('M5: trojan на SRV1, door_key в листинге владельца', srvDev?.owner === wH.id && !!key && key.startsWith('door_key'), key)

  // cp door_key srv1 → deck (источник остаётся, §16.2 ревизия 3)
  send(H, { t: 'run', prog: 'cp', dev: 'srv1', dst: 'deck', data: key })
  const cpStart = await waitNew(H, 'deck', 5000, (m) => (m.progs || []).some((p) => p.prog === 'cp' && p.data === key)).catch(() => null)
  check('M5: cp door_key srv1→deck запущен (мб/скорость в процессе)', !!cpStart && cpStart.progs.some((p) => p.prog === 'cp' && p.mbLeft > 0))
  let copied = false
  for (let i = 0; i < 250 && !copied; i++) {
    const d = [...H.msgs].reverse().find((m) => m.t === 'deck')
    copied = (d?.data || []).some((it) => it.n === key)
    if (!copied) await sleep(100)
  }
  check('M5: door_key приехал на деку', copied)

  // decrypt на SRV1 (NPU ×3 → 6 МБ/с): 60 МБ ≈ 10 с → codes.door команде
  send(H, { t: 'run', prog: 'decrypt', dev: 'srv1', data: key })
  const codes = await waitNew(H, 'codes', 20000, (m) => !!m.door).catch(() => null)
  check('M5: decrypt на SRV1 → codes.door команде', !!codes && /^\d{4}$/.test(codes.door), codes?.door)

  // замок d3 — физический ввод у клавиатуры: издалека denied too_far
  send(H, { t: 'jackout' })
  await sleep(300)
  send(H, { t: 'enter', dev: 'd3', code: '0000' })
  const far = await waitNew(H, 'denied', 3000, (m) => m.reason === 'too_far').catch(() => null)
  check('M5: enter издалека от клавиатуры → denied too_far', !!far)
  H.ws.close()
}

clients.forEach((c) => c.ws.readyState === 1 && c.ws.close())

// --- §15.40: /api/diag — диагностика ввода по нику (после разбора, чтобы не
// влиять на балансовые проверки выше: это отдельный клиент в конец) ---
{
  const dOn = await (await fetch(`${BASE}/api/diag?name=DiagMarked&on=1`)).json()
  check('diag: /api/diag?on=1 принимает имя', dOn.on === 1, JSON.stringify(dOn))
  const dc = await connect()
  send(dc, { t: 'join', name: 'DiagMarked', cls: 'assault' })
  const dw = await waitFor(dc, (m) => m.t === 'welcome', 4000).catch(() => null)
  check('diag: помеченный join получает welcome.diag=1', dw?.diag === 1, JSON.stringify(dw))
  // мгновенное выкл онлайн-носителю (без перезахода)
  await fetch(`${BASE}/api/diag?name=DiagMarked&on=0`)
  const dOff = await waitFor(dc, (m) => m.t === 'diag' && m.on === 0, 4000).catch(() => null)
  check('diag: on=0 летит онлайн-носителю без перезахода', !!dOff)
  dc.ws.close()
  const bad = await fetch(`${BASE}/api/diag?name=X`) // без on=
  check('diag: запрос без on → 400', bad.status === 400)
}

console.log(failures === 0 ? '\nE2E: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓' : `\nE2E: ПРОВАЛОВ ${failures}`)
process.exit(failures === 0 ? 0 : 1)
