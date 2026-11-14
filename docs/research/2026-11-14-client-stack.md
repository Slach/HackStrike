# Research: клиентский стек для браузерного session-FPS (2026-11-14)

> Research через web-поиск, проверка активности проектов на 2026-11-14.
> **Решение пользователя: Babylon.js.** Vite + TypeScript — без альтернатив.
> Скелет — без физдвижка (raycast-контроллер); физика на этапе демо
> (с Babylon логичнее его родной бесплатный Havok WASM, а не Rapier —
> вопрос отложен до этапа демо).

## Проверка «подозрительных» названий

**witch-engine** и **concerning data** — не существуют (проверено поиском: ни GitHub, ни npm, ни обсуждений). Реальные «другие» TS-движки, найденные в 2025–2026: Galacean (ex-Oasis, Alibaba, активен, но interactive-движок, не FPS), TSGL, Zephyr3D — нишевое, для FPS не брать.

## Таблица 1. Движки / рендер

| | Three.js | Babylon.js | PlayCanvas (engine) | LittleJS |
|---|---|---|---|---|
| **Состояние (2026)** | Активен; r187 — 30.10.2026, релизы каждые ~2 мес | Активен; 9.0 — 03.2026, минорные еженедельно (9.29 — 10.2026) | Активен; v2.24.1 — 12.11.2026 | Активен; 3D-рендер добавлен в 2025 (v1.19–1.23) |
| **Пригодность для FPS** | Да, стандарт де-факто: официальный PointerLockControls, FPS-примеры в мануале | Да: сцены, инспектор, камера, инпут из коробки | Да: полноценный движок (scene graph, инпут, физика) | **Нет для 3D-FPS**: 3D — лёгкий рендер «поверх 2D» |
| **Физика в комплекте** | Нет (мануал рекомендует Rapier) | Да: **Havok WASM бесплатно с v6**, + Cannon/Ammo/Oimo плагины | Да: ammo.js (сборка .wasm) | Простая 2D-физика |
| **Размер бандла** | ~168–185 КБ gzip (webgpu ~300 КБ) | ~1,4 МБ min; на практике билд в разы больше three (до ~4 МБ без treeshake) | ~1 МБ min (оценка) | ~20–30 КБ min |
| **Качество TS** | `@types/three` (обслуживается командой three) | Написан на TS — эталонные типы | TS-декларации в npm-пакете | Написан на TS |
| **Лицензия** | MIT | Apache 2.0 | Движок MIT; редактор — hosted, бесплатно только публичные проекты, приватные от $15/мес | MIT |

Источники: [three.js r187](https://github.com/mrdoob/three.js/releases), [PointerLockControls](https://threejs.org/docs/pages/PointerLockControls.html), [three.js manual: Physics](https://threejs.org/manual/#en/Physics), [Babylon releases](https://github.com/BabylonJS/Babylon.js/releases), [Havok в Babylon](https://doc.babylonjs.com/features/featuresDeepDive/physics/havokPlugin), [PlayCanvas engine](https://github.com/playcanvas/engine), [playcanvas.com/products/engine](https://playcanvas.com/products/engine), [LittleJS](https://github.com/KilledByAPixel/LittleJS), [анонс 3D в LittleJS](https://frankforce.com/littlejs-is-2d-and-3d-now).

## Таблица 2. Физика

| | Rapier (`@dimforge/rapier3d-compat`) | cannon-es | ammo.js | jolt-physics | Свой кинематик на raycast |
|---|---|---|---|---|---|
| **Состояние** | Активен; 0.21.0 — ~09.2026, ~17 млн загрузок/нед | **Заброшен**: 0.20.0 — 04.2021 | Минимальная активность, релизов нет | Активен; 1.1.1 — 10.2026, официальный three.js-аддон | — (свой код) |
| **Перф** | Rust→WASM, лучший в классе | JS, медленный | C++→Wasm, старый Bullet | C++→Wasm, AAA-уровень (Godot 4.4, Horizon) | Дёшево для AABB-воксов |
| **Character controller** | Встроенный KinematicCharacterController | Нет | Нет | Есть, но API — ручное управление памятью | Классика Quake/HL, полный FPS-feel |
| **Вердикт** | Выбор по умолчанию (для three.js) | Не брать | Не брать | Оверкилл для MVP | Отлично для скелета и hitscan по вокселям |

Источники: [npm rapier3d-compat](https://www.npmjs.com/package/@dimforge/rapier3d-compat), [npm cannon-es](https://www.npmjs.com/package/cannon-es), [github.com/kripken/ammo.js](https://github.com/kripken/ammo.js), [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js), [Rapier KCC docs](https://rapier.rs/docs/user_guides/javascript/character_controller).

Примечание к решению: у Babylon.js физика идёт через его плагинную систему; Havok WASM бесплатен и является first-class — при выборе Babylon для демо вопрос «Havok vs Rapier» надо решить отдельно.

## Сеть (клиент)

- **Нативный WebSocket** (не Socket.IO): оверхед socket.io на каждое сообщение + фокус на надёжности, а не задержке. Socket.IO имеет смысл только для лобби/чата.
- **Туннели:** Cloudflare-прокси убивает простаивающие WS за ~100 с (код 1006) — при тике 20–30 Гц соединение не простаивает; heartbeat <60 с + reconnect с backoff. zrok поддерживает WebSocket-туннели. Игра в iframe на itch.io ходит по `wss://` наружу без ограничений (WS не подчиняется CORS).
- **Интерполяция снапшотов:** готовых живых TS-библиотек нет — норма практики hand-roll (буфер 2–3 снапшота, интерполяция ~100 мс в прошлом). `@geckos.io/snapshot-interpolation` 1.1.1 — стабильна, но не публикуется ~2 года; можно завендорить как референс.
- **Geckos.io (WebRTC UDP) не брать** для MVP: проброс WebRTC через zrok — боль, выигрыша на 20–30 Гц нет.

## Сборка

Vite + TypeScript — дефолт (официальная инструкция three.js; Babylon-сообщество на тех же шаблонах). WASM-интеграция: `rapier3d-compat` инлайнит WASM в base64, проблем нет.

## Воксельный MVP

- **noa-engine не брать**: последний релиз ~3 года назад.
- Для арены не нужен движок «майнкрафт-мира»: greedy meshing — ~150–200 строк (алгоритм 0fps), чанки в `BufferGeometry`; hitscan-коллизии = AABB-проверки по сетке.
- Арт: Kenney CC0 (kenney.nl/assets — glTF) — быстрый первый арт-пасс. Greedy meshing писать только если разрушаемость/редактирование мира — кор-механика (hacker-view — хороший кандидат).

Источники: [npm noa-engine](https://www.npmjs.com/package/noa-engine), [0fps: Meshing in a Minecraft Game](https://0fps.net/2012/06/30/meshing-in-a-minecraft-game/), [Greedy meshing на JS](https://www.jameshylands.co.uk/2022/10/greedy-meshing-in-javascript.html), [kenney.nl/assets](https://kenney.nl/assets).
