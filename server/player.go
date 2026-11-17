package main

import "time"

// Классы и оружие — числа из ГДД §3.1/§3.3, менять только через ГДД.
type weapon struct {
	name     string
	damage   int
	interval time.Duration // минимальный интервал между выстрелами
}

type classStats struct {
	hp     int
	speed  float64 // м/с
	weapon weapon
}

var classes = map[string]classStats{
	// sniper: ваншот всех, кроме heavy (2 выстрела) — ГДД §3.3; гейт
	// «сначала зум» — клиентский (авто-зум ×1.5 через 0.1 с в поле зрения).
	"sniper":  {hp: 100, speed: 5.5, weapon: weapon{name: "bolt", damage: 150, interval: 1200 * time.Millisecond}},
	"assault": {hp: 125, speed: 6.5, weapon: weapon{name: "ar", damage: 10, interval: time.Second / 8}},
	"heavy":   {hp: 200, speed: 4.5, weapon: weapon{name: "minigun", damage: 7, interval: time.Second / 12}},
	// hacker (§3.3): дефолт — пистолет; нож — переключение (Q, M2): melee
	// 1.8 м, 60 урона, 1.2 с, перерубает кабели (§12.1).
	"hacker": {hp: 100, speed: 6.0, weapon: weapon{name: "pistol", damage: 18, interval: time.Second / 3}},
}

const defaultClass = "assault"

func classOr(cls string) (string, classStats) {
	if st, ok := classes[cls]; ok {
		return cls, st
	}
	return defaultClass, classes[defaultClass]
}

// histPosAt — позиция ног ago тиков назад (0 = текущая). Если истории мало
// (только заспавнился), отдаём самую старую известную.
func (pl *player) histPosAt(ago int) vec3 {
	if len(pl.posHist) == 0 {
		return pl.pos
	}
	i := len(pl.posHist) - 1 - ago
	if i < 0 {
		i = 0
	}
	return pl.posHist[i]
}

// keysState — клавиши из последнего input-сообщения. M2: interact (space) —
// edge-джек-ин у терминала/радио (§12.5).
type keysState struct {
	w, a, s, d, interact bool
}

// player — всё состояние игрока. Владелец — горутина комнаты (инвариант 2).
// pos — точка у ног; глаза = pos + eyeHeight.
type player struct {
	id   uint64
	name string
	team int
	cls  string

	pos      vec3
	vy       float64
	grounded bool
	yaw      float64 // LH-конвенция Babylon: 0 = взгляд в +Z, рост по часовой сверху
	pitch    float64 // радианы, +вверх, кламп ±89°

	hp        int
	alive     bool
	respawnAt time.Time

	// posHist — недавние позиции ног (старая→новая), по одной за тик.
	// Lag compensation выстрелов (ГДД §9.4): клиент видит цель ~100 мс в
	// прошлом из-за интерполяции снапшотов, сервер проверяет и отмотанный AABB.
	posHist []vec3

	inputSeq uint64
	keys     keysState

	lastShot         time.Time
	inputCount       int // анти-спам: не более maxInputRate в секунду
	inputWindowStart time.Time

	// Кибер-слой M2 (§12): состояние деки. Джекнутый стоит на месте и не
	// стреляет; progs — процессы на деке (честные очереди); scanned —
	// устройства, открытые своим portscan'ом (кибер-карта, туман войны).
	jacked       bool
	jackHost     *device
	jacking      *device // устройство, у которого ставится канал джек-ина (§12.1 «дорогой вход»; nil = нет)
	jackT        float64 // прогресс установки канала, с
	progs        []*program
	nextProgID   int
	scanned      map[string]bool
	prevInteract bool // edge-детект space между тиками
}
