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
	// «сначала зум» — клиентский (авто-зум ×2 через 0.1 с в поле зрения).
	"sniper":  {hp: 100, speed: 5.5, weapon: weapon{name: "bolt", damage: 150, interval: 1200 * time.Millisecond}},
	"assault": {hp: 125, speed: 6.5, weapon: weapon{name: "ar", damage: 10, interval: time.Second / 8}},
	"heavy":   {hp: 200, speed: 4.5, weapon: weapon{name: "minigun", damage: 7, interval: time.Second / 12}},
	"hacker":  {hp: 100, speed: 6.0, weapon: weapon{name: "pistol", damage: 18, interval: time.Second / 3}},
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

// keysState — клавиши из последнего input-сообщения (interact в M1
// принимается, но ни на что не влияет).
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
}
