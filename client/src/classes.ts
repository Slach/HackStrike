// Class roster — v0 balance numbers from GDD §3.1. The server is the
// authority; these only pace client-side auto-fire intents and paint cards.

import type { Cls } from './net'

export interface ClassDef {
  key: Cls
  label: string
  weapon: string
  hp: number
  speed: number
  damage: number
  rate: string // human-readable fire tempo for the class cards
  fireInterval: number // seconds between fire intents (client-side pacing)
  note: string
}

export const CLASSES: readonly ClassDef[] = [
  {
    key: 'sniper',
    label: 'СНАЙПЕР',
    weapon: 'BOLT-ВИНТОВКА',
    hp: 100,
    speed: 5.5,
    damage: 150,
    rate: '1 / 1.2с',
    fireInterval: 1.2,
    note: 'авто-зум ×1.5, ваншот кроме heavy',
  },
  {
    key: 'assault',
    label: 'АВТОМАТЧИК',
    weapon: 'AR // АВТОМАТ',
    hp: 125,
    speed: 6.5,
    damage: 10,
    rate: '8 / с',
    fireInterval: 0.125,
    note: 'самый быстрый',
  },
  {
    key: 'heavy',
    label: 'HEAVYGUN',
    weapon: 'MINIGUN',
    hp: 200,
    speed: 4.5,
    damage: 7,
    rate: '12 / с',
    fireInterval: 0.083,
    note: 'спин-ап 0.5с',
  },
  {
    key: 'hacker',
    label: 'ХАКЕР',
    weapon: 'ПИСТОЛЕТ + НОЖ',
    hp: 100,
    speed: 6.0,
    damage: 18,
    rate: '3 / с',
    fireInterval: 0.33,
    note: 'Q: пистолет/нож, нож режет кабели',
  },
]

export const CLASS_BY_KEY: Record<Cls, ClassDef> = {
  sniper: CLASSES[0],
  assault: CLASSES[1],
  heavy: CLASSES[2],
  hacker: CLASSES[3],
}
