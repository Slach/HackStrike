// M2 live smoke: джек-ин → portscan → vulnscan → trojan → дверь → кабель → изоляция.
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:9999'
const WS = BASE.replace(/^http/, 'ws') + '/ws'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${name}${extra ? '  [' + extra + ']' : ''}`)
  if (!cond) failures++
}
const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket(WS)
  const c = { ws, msgs: [] }
  ws.onopen = () => res(c)
  ws.onerror = rej
  ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data))
})
const send = (c, m) => c.ws.send(JSON.stringify(m))
const lastSnap = (c) => [...c.msgs].reverse().find((m) => m.t === 'snap')
const meOf = (c) => { const w = c.msgs.find((m) => m.t === 'welcome'); return lastSnap(c)?.players.find((p) => p.id === w.id) }
const waitFor = (c, pred, ms = 8000) => new Promise((res, rej) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    const m = c.msgs.find(pred)
    if (m) { clearInterval(iv); res(m) }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')) }
  }, 30)
})

const map = await (await fetch(`${BASE}/api/map`)).json()
const t1 = map.props.find((p) => p.id === 't1')
const c1 = map.props.find((p) => p.id === 'c1')
// ближний к базе сегмент 0→1 (вдоль стены комнаты базы, прямая видимость)
const cableMid = [
  (c1.points[0][0] + c1.points[1][0]) / 2,
  (c1.points[0][1] + c1.points[1][1]) / 2,
  (c1.points[0][2] + c1.points[1][2]) / 2,
]
console.log(`t1@${t1.pos}, c1 середина: ${cableMid.map((v) => v.toFixed(1)).join(',')}`)

const S = await connect() // жертвенный: занимает t1, чтобы H и A оба попали на запад
const H = await connect() // хакер
const A = await connect() // автоматчик (режет кабель пулями)
send(S, { t: 'join', name: 'Balance', cls: 'assault', team: 1 })
await sleep(300)
send(H, { t: 'join', name: 'NeoM2', cls: 'hacker', team: 0 })
await sleep(300)
send(A, { t: 'join', name: 'Cutter', cls: 'assault', team: 0 })
await sleep(600)

const walkTo = async (c, tx, tz) => {
  for (let i = 0; i < 250; i++) {
    const me = meOf(c)
    if (!me) { await sleep(50); continue }
    const dx = tx - me.x, dz = tz - me.z
    if (Math.hypot(dx, dz) < 1.5) break
    send(c, { t: 'input', seq: 10000 + i, keys: { w: 1, a: 0, s: 0, d: 0, interact: 0 }, yaw: Math.atan2(dx, dz), pitch: 0 })
    await sleep(33)
  }
}

// 1. дойти до терминала
await walkTo(H, t1.pos[0], t1.pos[2])
const hp0 = meOf(H)
console.log(`  хакер у терминала: dist=${Math.hypot(t1.pos[0] - hp0.x, t1.pos[2] - hp0.z).toFixed(2)} м`)
check('хакер дошёл до терминала (<2 м)', Math.hypot(t1.pos[0] - hp0.x, t1.pos[2] - hp0.z) < 2.0)

// 2. джек-ин (interact edge)
for (let i = 0; i < 3; i++) { send(H, { t: 'input', seq: 900 + i, keys: { w: 0, a: 0, s: 0, d: 0, interact: 1 }, yaw: 0, pitch: 0 }); await sleep(33) }
const jackin = await waitFor(H, (m) => m.t === 'jackin')
check('джек-ин', jackin.host === 't1' && jackin.deck && jackin.deck.ram === 4, `net=${jackin.deck.net}`)

// 3. portscan ×3 (прогрессивный, 1 хоп за запуск) → сеть открыта
const scansCount = () => H.msgs.filter((m) => m.t === 'scan').length
for (let i = 0; i < 3; i++) {
  const before = scansCount()
  send(H, { t: 'run', prog: 'portscan' })
  await waitFor(H, (m) => m.t === 'scan' && false, 1).catch(() => {}) // noop
  while (scansCount() <= before) await sleep(100)
  await sleep(300)
}
const scan = [...H.msgs].reverse().find((m) => m.t === 'scan')
const ids1 = scan.devices.map((d) => d.id)
check('3 portscan-а раскрыли сеть (вкл. дверь d1 и s2)', ids1.includes('d1') && ids1.includes('s2'), ids1.join(','))

// 4. vulnscan → trojan → владение дверью
send(H, { t: 'run', prog: 'vulnscan', dev: 'd1' })
await sleep(3600) // 3 c при полной доле + запас
send(H, { t: 'run', prog: 'trojan', dev: 'd1' })
await sleep(2600)
const myId = H.msgs.find((m) => m.t === 'welcome').id
const owned = [...H.msgs].reverse().find((m) => m.t === 'scan')?.devices.find((d) => d.id === 'd1')
check('trojan захватил дверь', owned && owned.owner === myId, `owner=${owned && owned.owner}`)

// 5. ctrl toggle → состояние двери перевернулось в snap.props
const d1prop = () => lastSnap(H).props?.find((p) => p.id === 'd1')
const openBefore = d1prop()?.open ?? false
send(H, { t: 'ctrl', dev: 'd1', action: 'toggle' })
await sleep(500)
check('дверь d1 переключилась (snap.props)', d1prop()?.open === !openBefore, `было=${openBefore}, стало=${d1prop()?.open}`)

// 6. jackout → движение вернулось
send(H, { t: 'jackout' })
await sleep(300)
const before = { ...meOf(H) }
for (let i = 0; i < 20; i++) { send(H, { t: 'input', seq: 2000 + i, keys: { w: 1, a: 0, s: 0, d: 0, interact: 0 }, yaw: 0, pitch: 0 }); await sleep(33) }
const after = meOf(H)
check('jackout: движение восстановлено', Math.hypot(after.x - before.x, after.z - before.z) > 0.5, `Δ=${Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)}`)

// 7. перерубить c1 пулями → изоляция t1
{
  await walkTo(A, 5.5, 29)
  { const p = meOf(A); if (Math.hypot(5.5 - p.x, 29 - p.z) > 2.5) { console.log(`  каттер НЕ дошёл: (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) team=${p.team} — проход через стены невозможен`); } }
  for (let i = 0; i < 3; i++) { send(A, { t: 'input', seq: 5000 + i, keys: { w: 0, a: 0, s: 0, d: 0, interact: 0 }, yaw: 0, pitch: 0 }); await sleep(33) }
  await sleep(150)
  const a = meOf(A)
  const dx = cableMid[0] - a.x, dz = cableMid[2] - a.z, dy = cableMid[1] - (a.y + 1.6)
  const h = Math.hypot(dx, dz)
  const yaw = Math.atan2(dx, dz), pitch = Math.atan2(dy, h)
  const n0 = A.msgs.length
  for (let i = 0; i < 25; i++) { send(A, { t: 'fire', yaw, pitch }); await sleep(150) }
  const myA = A.msgs.find((m) => m.t === 'welcome').id
  const tos = A.msgs.slice(n0).filter((m) => m.t === 'shot' && m.by === myA).slice(0, 3).map((s) => s.to)
  console.log('  первые shot.to:', JSON.stringify(tos))
}
await sleep(400)
const c1prop = () => lastSnap(H).props?.find((p) => p.id === 'c1')
check('кабель c1 перерублен пулями', c1prop()?.severed === true, `severed=${c1prop()?.severed}`)

// 8. повторный portscan не видит сеть за кабелем
await walkTo(H, t1.pos[0], t1.pos[2])
for (let i = 0; i < 3; i++) { send(H, { t: 'input', seq: 3000 + i, keys: { w: 0, a: 0, s: 0, d: 0, interact: 1 }, yaw: 0, pitch: 0 }); await sleep(33) }
await waitFor(H, (m) => m.t === 'jackin')
H.msgs.length = 0
send(H, { t: 'run', prog: 'portscan' })
const scan2 = await waitFor(H, (m) => m.t === 'scan')
const ids2 = scan2.devices.map((d) => d.id)
check('после обрыва сеть не видна (d1/s2 отсутствуют)', !ids2.includes('d1') && !ids2.includes('s2'), ids2.join(',') || '(пусто)')

H.ws.close(); A.ws.close()
console.log(failures === 0 ? '\nM2 SMOKE: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ ✓' : `\nM2 SMOKE: ПРОВАЛОВ ${failures}`)
process.exit(failures ? 1 : 0)
