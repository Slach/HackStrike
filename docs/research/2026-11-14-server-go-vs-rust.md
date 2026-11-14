# Research: Go vs Rust для авторитарного WS-сервера браузерного FPS (2026-11-14)

> Research через web-поиск + GitHub API/crates.io на 2026-11-14.
> **Решение пользователя: Go** (соло-дев, MVP-first, 10–20 игроков, 20–30 Гц, docker-compose, macOS arm64).

## Сравнительная таблица

| Критерий | **Go** | **Rust** |
|---|---|---|
| **WS-экосистема** | Отличная. `coder/websocket` v1.8.15 (июнь 2026, активен, рекомендован для новых проектов); `gorilla/websocket` v1.5.3 (стабильная классика, релизы замерли с 06.2024); `gobwas/ws` — для десятков тысяч коннектов | Хорошая. `axum` v0.8.9 (апр 2026) — идиоматичный выбор, WS из коробки; `tokio-tungstenite` v0.30.0; `fastwebsockets` — нишевый |
| **Fit под игровой цикл** | Горутина-на-комнату + `time.NewTicker` + каналы — канонический паттерн; гонки избегаются дизайном (один владелец состояния) | tokio-таски аналогично; ECS: Bevy v0.20.1 headless возможен, но тяжёл для MVP; `specs` мёртв (2024). Для 10–20 игроков plain structs + Vec лучше ECS |
| **Предсказуемость задержки** | STW-паузы GC стабильно <1 мс, не растут с кучей; при бюджете кадра 33 мс (30 Гц) незаметно. Реальный риск — mark assist/аллокации, лечится `sync.Pool`, GOGC/GOMEMLIMIT | Нулевая (нет GC). Но на 20–30 Гц преимущество не реализуется |
| **Скорость разработки (соло)** | Высокая: минимум концепций, ошибки видны сразу | Ниже: borrow checker, lifetimes, async-трейты |
| **Компиляция/итерация** | Инкрементальная сборка — секунды; критично для частых правок game feel | Медленнее на порядок на малом проекте (LLVM, монморфизация) |
| **Docker/ops** | `CGO_ENABLED=0` → статический бинарник → scratch (~10–30 МБ); кросс-компиляция на linux/arm64 — одна env-переменная; ~20–50 МБ RSS | musl → тоже scratch; кросс через `cross` (Docker) — капризнее; RSS ещё ниже |
| **Экосистема игровых серверов** | Nakama v3.42.0 (активен) — готовый бэкенд; для MVP overkill | bevy_replicon (если клиент тоже Bevy); renet — UDP, не для браузера |
| **LLM-кодогенерация** | Заметно лучше: консистентный идиоматичный код с первой попытки | Хуже: borrow checker → больше итераций, нужен stricter review |

## Вердикт: Go

1. **Бюджет кадра 33 мс** — GC-пауза <1 мс это <3% бюджета. Аргумент «Rust = нет GC» не конвертируется в преимущество на 30 Гц (стал бы критичен при 60–128 tick).
2. **Скорость итерации** — главный множитель производительности соло-дева.
3. **LLM-кодогенерация** — меньше переделок.
4. **Ops** — статический бинарник, тривиальная кросс-компиляция.

**Чем Rust был бы лучше:** детерминированная задержка без GC-тюнинга; ещё меньший RSS (десятки комнат на 1 ГБ VPS); compile-time защита от гонок; общий код симуляции, если клиент нативный/Bevy.

## Рекомендуемые библиотеки (Go)

- **WebSocket: `github.com/coder/websocket`** v1.8.15 (активен, контекстный API, безопасная конкуренция записи) + `wsjson` для JSON-фреймов.
- **Сериализация:** MVP — JSON (handshake/lobby/chat/события, видно в devtools); затем MessagePack (`vmihailenco/msgpack` + `@msgpack/msgpack` в браузере) для снапшотов; при стабилизации формата — proto3 (`protobuf-go` + `@bufbuild/protobuf`). При 20 игроках × 30 Гц снапшот ~1 КБ = ~600 КБ/с на комнату — и JSON работал бы.
- **Скелет тик-лупа** (комната = одна горутина, без mutex на игровом состоянии):

```go
func (r *Room) Run(ctx context.Context) {
    ticker := time.NewTicker(time.Second / 30) // фиксированный тик
    defer ticker.Stop()
    for {
        select {
        case <-ticker.C:
            r.drainInputs()       // неблокирующее чтение из канала входов
            r.simulate(1.0 / 30)  // детерминированный шаг симуляции
            r.broadcastSnapshot() // каждому коннекту — в его send-канал
        case c := <-r.joins:  r.handleJoin(c)
        case c := <-r.leaves: r.handleLeave(c)
        case <-ctx.Done():    return
        }
    }
}
```

На каждого клиента — своя горутина записи с `WriteDeadline` и буферизованным send-каналом (drop-политика при переполнении, а не блокировка тика). Буферы снапшотов — `sync.Pool`; env: `GOMEMLIMIT` + `GOGC` после профилирования.

## Netcode reality check

- **WebSocket = TCP = head-of-line blocking** — да, но браузерные FPS (Krunker и т.п.) годами живут на WSS, компенсируя клиентским предсказанием, интерполяцией снапшотов и серверной валидацией попаданий. **20–30 Гц по WSS — нормальная играбельная конфигурация.**
- **WebRTC DataChannel** технически лучше для стейт-апдейтов, но: сигналинг, ICE/STUN, отдельный путь от HTTPS/zrok; `geckos.io` v3.1.0 (03.2026) — активность низкая, рискованная зависимость. **Отложить**; если понадобится — WebTransport к тому времени созреет, миграция изолирована в транспортном слое.

## Источники

- gorilla/websocket восстановление (issue #370): https://github.com/gorilla/websocket/issues/370 ; релизы: https://github.com/gorilla/websocket/releases
- coder/websocket (переезд nhooyr → coder): https://coder.com/blog/websocket
- Бенчмарк Go WS-библиотек (gorilla 514 МБ/с vs gobwas 283 vs coder 254; при ≤1000 клиентов разница мала): https://github.com/gosuda/go-websocket-libraries
- Go GC суб-миллисекундные паузы: https://go.dev/doc/faq , https://go.dev/blog/ismmkeynote
- axum: https://github.com/tokio-rs/axum ; tokio-tungstenite: https://github.com/snapview/tokio-tungstenite
- Bevy / bevy_replicon / specs: https://github.com/bevyengine/bevy , https://github.com/simgine/bevy_replicon , https://github.com/amethyst/specs
- Nakama authoritative multiplayer: https://heroiclabs.com/docs/nakama/concepts/multiplayer/authoritative
- WebSocket vs WebRTC для браузерных игр: https://developers.rune.ai/blog/webrtc-vs-websockets-for-multiplayer-games
- geckos.io v3.1.0: https://github.com/geckosio/geckos.io
- Go/Rust scratch-образы: https://medium.com/google-cloud/alpine-distroless-or-scratch-caac35250e0c
- LLM-кодогенерация Go vs Rust: https://arxiv.org/abs/2408.13255 , https://medium.com/@lcamry/a-case-for-go-as-the-best-language-for-ai-agents-uncut-edition-b0a3c0f07895
- Rust compile times: https://www.feldera.com/blog/cutting-down-rust-compile-times-from-30-to-2-minutes-with-one-thousand-crates
