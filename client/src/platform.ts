// Определение ОС игрока — только для текста подсказки джек-аута в шапке деки
// (ГДД §11 2026-11-21: второе легальное место снифинга рядом с §15.37;
// геймплей и UI-режим платформой не определяются). Touch-устройства сюда не
// доходят: у них кнопка ВЫХОД. userAgentData есть в Chromium, Firefox и
// Safari отваливаются на navigator.platform ('Win32', 'MacIntel',
// 'Linux x86_64').

export type OsName = 'windows' | 'macos' | 'linux' | 'other'

interface NavigatorUAData {
  readonly platform?: string
}

export function osName(): OsName {
  const uaData = (navigator as Navigator & { userAgentData?: NavigatorUAData })
    .userAgentData
  const p = uaData?.platform ?? navigator.platform
  if (/Win/i.test(p)) return 'windows'
  if (/Mac/i.test(p)) return 'macos'
  if (/Linux|CrOS/i.test(p)) return 'linux'
  return 'other'
}
