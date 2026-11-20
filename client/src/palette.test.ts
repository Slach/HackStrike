// Юнит-тесты слэш-палитры hackview (ГДД §13.3/§16.2/§16.4): кандидатные
// грамматки и главный инвариант из плейтестов M5 — «терминальный токен уже
// точный → Enter ИСПОЛНЯЕТ, а не дописывает его по кругу» (регребы
// «vulnscan cam2 cam2…», «door_key cp deck deck…», 3bd91dd). Прогон: npm test.

import { afterEach, describe, expect, it } from 'vitest'
import { HackView } from './hackview'
import type { ClientMessage, ServerMessage } from './net'

const ME = 1

function mkDev(id: string, kind: string, owner: number | null, extra = {}) {
  return { id, kind, x: 0, y: 1, z: 0, owner, links: [], ...extra } as never
}

interface World {
  deckData?: { n: string; mb: number; enc: boolean }[]
  srv1Data?: { n: string; mb: number; enc: boolean }[]
}

function harness(host = 't1', world: World = {}) {
  document.body.innerHTML = '<div id="hackview"></div>'
  const sent: ClientMessage[] = []
  const hv = new HackView({
    send: (m) => sent.push(m),
    teamOf: () => null,
    nameOf: (id) => `p${id}`,
    jackout: () => {},
  })
  hv.setMyId(ME)
  hv.activate(
    { t: 'jackin', host, deck: { cpu: 0, npu: 2, ram: 4, net: 100 } } as Extract<
      ServerMessage,
      { t: 'jackin' }
    >,
    null,
  )
  hv.onScan({
    t: 'scan',
    devices: [
      mkDev('t1', 'terminal', null),
      mkDev('s1', 'switch', null),
      mkDev('cam2', 'camera', ME, { vulned: true }),
      mkDev('srv1', 'srv', ME, {
        mem: 512,
        memFree: 512 - (world.srv1Data?.[0]?.mb ?? 0),
        vulned: true,
        data: world.srv1Data,
      }),
    ],
  })
  hv.onDeck({
    t: 'deck',
    cpuLoad: 0,
    npuLoad: 0,
    ramUsed: 0,
    netLoad: 0,
    memUsed: world.deckData?.[0]?.mb ?? 0,
    mem: 256,
    data: world.deckData ?? [],
    progs: [],
  } as Extract<ServerMessage, { t: 'deck' }>)
  return { hv, sent, runs: () => sent.filter((m) => m.t === 'run') as Extract<ClientMessage, { t: 'run' }>[] }
}

function openPalette(hv: HackView): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Slash', key: '/' }))
  expect(hv.isPaletteOpen).toBe(true)
}

function type(text: string): void {
  const input = document.querySelector<HTMLInputElement>('.hv-pal-input')
  expect(input).not.toBeNull()
  input!.value = text
  input!.dispatchEvent(new Event('input'))
}

function inputVal(): string {
  return document.querySelector<HTMLInputElement>('.hv-pal-input')?.value ?? ''
}

function pressEnter(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }))
}

const listText = (): string =>
  [...document.querySelectorAll('.hv-pal-list *')].map((e) => e.textContent).join('|')

let cur: HackView | null = null
afterEach(() => {
  cur?.deactivate()
  cur = null
  document.body.innerHTML = '<div id="hackview"></div>'
})

describe('палитра: терминальный токен точен → Enter исполняет (§13.3)', () => {
  it('регреба «vulnscan cam2 cam2 cam2…»: точная цель → run без дописывания', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('vulnscan cam2')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'vulnscan', dev: 'cam2' })
    expect(h.hv.isPaletteOpen).toBe(false)
  })

  it('тот же guard для «prog dev␣» (хвостовой пробел = дописываемый токен пуст)', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('vulnscan cam2 ')
    expect(listText()).toContain('ГОТОВА')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'vulnscan', dev: 'cam2' })
  })

  it('обратный порядок «cam2 vulnscan» → run dev cam2', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('cam2 vulnscan')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'vulnscan', dev: 'cam2' })
  })

  it('guard НЕ ломает дописывание префикса: «cam» → вставка cam2, не пуск', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('cam')
    pressEnter()
    expect(h.runs()).toEqual([])
    expect(h.hv.isPaletteOpen).toBe(true)
    expect(inputVal()).toBe('cam2 ')
  })

  it('reverse-форма с полным приёмником «dk cp deck» (jack srv1) → run cp без deck-loop', () => {
    const h = harness('srv1', { srv1Data: [{ n: 'dk', mb: 60, enc: true }] })
    cur = h.hv
    // таб srv1 активен (иначе dataCtxHost = t1, а dk лежит на srv1): T → srv1 → Enter
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT', key: 't' }))
    type('srv1')
    pressEnter()
    openPalette(h.hv)
    type('dk cp deck')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'cp', dev: 'srv1', dst: 'deck', data: 'dk' })
    expect(h.hv.isPaletteOpen).toBe(false)
  })

  it('forward «cp dk srv1» (dk на деке) → run cp deck→srv1', () => {
    const h = harness('t1', { deckData: [{ n: 'dk', mb: 60, enc: true }] })
    cur = h.hv
    openPalette(h.hv)
    type('cp dk srv1')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'cp', dev: 'deck', dst: 'srv1', data: 'dk' })
    expect(h.hv.isPaletteOpen).toBe(false)
  })

  it('одноаргументная «rm dk» → run rm', () => {
    const h = harness('t1', { deckData: [{ n: 'dk', mb: 60, enc: true }] })
    cur = h.hv
    openPalette(h.hv)
    type('rm dk')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'rm', dev: 'deck', data: 'dk' })
    expect(h.hv.isPaletteOpen).toBe(false)
  })

  it('«decrypt dk@srv1» → run decrypt на хосте данных (§16.4)', () => {
    const h = harness('t1', { srv1Data: [{ n: 'dk', mb: 60, enc: true }] })
    cur = h.hv
    openPalette(h.hv)
    type('decrypt dk@srv1')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'decrypt', dev: 'srv1', data: 'dk' })
    expect(h.hv.isPaletteOpen).toBe(false)
  })

  it('регреба «cp deck…» в data-форме: «data cp dk deck deck» не дописывает лишнего', () => {
    const h = harness('t1', { deckData: [{ n: 'dk', mb: 60, enc: true }] })
    cur = h.hv
    openPalette(h.hv)
    type('data cp dk srv1')
    pressEnter()
    expect(h.runs()).toContainEqual({ t: 'run', prog: 'cp', dev: 'deck', dst: 'srv1', data: 'dk' })
  })

  it('неполный «vulnscan» без цели: не шлёт, подсказывает цель', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('vulnscan ')
    expect(listText()).toContain('CAM2') // список целей — до Enter (Enter закроет пустую строку)
    pressEnter()
    expect(h.runs()).toEqual([])
  })

  it('data ls — терминал: Enter не шлёт run и не закрывает палитру (§16.2)', () => {
    const h = harness()
    cur = h.hv
    openPalette(h.hv)
    type('data ls')
    pressEnter()
    expect(h.runs()).toEqual([])
    expect(h.hv.isPaletteOpen).toBe(true)
  })
})
