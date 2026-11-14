package main

import "math"

// Кинематические константы (ГДД §9.3).
const (
	gravity        = 20.0 // м/с²
	autostepHeight = 0.55 // подъём на низкое препятствие при блоке (ступени 0.5)
	playerHalf     = 0.3  // половина ширины AABB (итого 0.6×1.8×0.6)
	playerHeight   = 1.8
	eyeHeight      = 1.6
)

type aabb struct{ min, max vec3 }

func playerBoxAt(pos vec3) aabb {
	return aabb{
		min: vec3{pos[0] - playerHalf, pos[1], pos[2] - playerHalf},
		max: vec3{pos[0] + playerHalf, pos[1] + playerHeight, pos[2] + playerHalf},
	}
}

func boxesOverlap(a, b aabb) bool {
	for i := 0; i < 3; i++ {
		if !(a.min[i] < b.max[i] && a.max[i] > b.min[i]) {
			return false
		}
	}
	return true
}

func (m *gameMap) overlapsAny(b aabb) bool {
	for i := range m.Colliders {
		if boxesOverlap(b, aabb{vec3(m.Colliders[i].Min), vec3(m.Colliders[i].Max)}) {
			return true
		}
	}
	return false
}

// wishDir — единичное горизонтальное направление из клавиш относительно yaw.
// W — вперёд по взгляду: forward=(sin yaw, 0, cos yaw); D — вправо.
func wishDir(yaw float64, k keysState) vec3 {
	f := vec3{math.Sin(yaw), 0, math.Cos(yaw)}
	r := vec3{math.Cos(yaw), 0, -math.Sin(yaw)}
	var v vec3
	if k.w {
		v = v.add(f)
	}
	if k.s {
		v = v.sub(f)
	}
	if k.d {
		v = v.add(r)
	}
	if k.a {
		v = v.sub(r)
	}
	return v.norm()
}

// blockFn — занят ли AABB: статическая геометрия + динамика (закрытые двери
// M2). Двери подаются отдельной функцией, а не списком коллайдеров, чтобы
// не мутировать карту при toggle.
type blockFn func(aabb) bool

// staticBlocked — только геометрия карты (мини-арены тестов, рейкасты).
func (m *gameMap) staticBlocked(b aabb) bool { return m.overlapsAny(b) }

// moveAxis — сдвиг по одной горизонтальной оси. При блоке: если игрок на
// земле и препятствие не выше autostep (лестницы) — подняться на его верх.
func (m *gameMap) moveAxis(pl *player, axis int, delta float64, blocked blockFn) {
	if delta == 0 {
		return
	}
	target := pl.pos
	target[axis] += delta
	if !blocked(playerBoxAt(target)) {
		pl.pos = target
		return
	}
	if !pl.grounded {
		return // в воздухе autostep не работает (прыжка нет)
	}
	// Верх самого высокого препятствия, которое дорастаем до autostep.
	// Двери сюда не смотрим: они 3 м высотой, autostep на них не сработает.
	newBox := playerBoxAt(target)
	step := 0.0
	for i := range m.Colliders {
		c := &m.Colliders[i]
		if !boxesOverlap(newBox, aabb{vec3(c.Min), vec3(c.Max)}) {
			continue
		}
		if top := c.Max[1]; top > pl.pos[1] && top-pl.pos[1] <= autostepHeight && top > step {
			step = top
		}
	}
	if step == 0 {
		return
	}
	target[1] = step
	if !blocked(playerBoxAt(target)) {
		pl.pos = target
	}
}

// applyPhysics — один шаг вертикали: гравитация, приземление, потолок.
func (m *gameMap) applyPhysics(pl *player, dt float64, blocked blockFn) {
	pl.vy -= gravity * dt
	target := pl.pos
	target[1] += pl.vy * dt
	box := playerBoxAt(target)
	if !blocked(box) {
		pl.pos = target
		pl.grounded = false
		return
	}
	if pl.vy < 0 {
		// Встать на самый высокий бокс под ногами (top не выше старых ног).
		best := math.Inf(-1)
		for i := range m.Colliders {
			c := &m.Colliders[i]
			if boxesOverlap(box, aabb{vec3(c.Min), vec3(c.Max)}) && c.Max[1] <= pl.pos[1]+0.001 && c.Max[1] > best {
				best = c.Max[1]
			}
		}
		if !math.IsInf(best, -1) {
			pl.pos[1] = best
			pl.grounded = true
		}
		pl.vy = 0
	} else {
		pl.vy = 0 // упёрлись головой
	}
}

// movePlayer — перемещение по статической геометрии (тестовые мини-арены).
// Игровой мир ходит через world.movePlayer: он учитывает двери и джек-ин.
func (m *gameMap) movePlayer(pl *player, dt float64) {
	m.movePlayerBlocked(pl, dt, m.staticBlocked)
}

func (m *gameMap) movePlayerBlocked(pl *player, dt float64, blocked blockFn) {
	wish := wishDir(pl.yaw, pl.keys)
	if wish != (vec3{}) {
		speed := classes[pl.cls].speed
		m.moveAxis(pl, 0, wish[0]*speed*dt, blocked)
		m.moveAxis(pl, 2, wish[2]*speed*dt, blocked)
	}
	m.applyPhysics(pl, dt, blocked)
}

// rayBoxT — параметр t входа луча в бокс (slab); -1 если не пересекает.
func rayBoxT(origin, dir vec3, b aabb) float64 {
	tmin, tmax := 0.0, math.Inf(1)
	for i := 0; i < 3; i++ {
		if math.Abs(dir[i]) < 1e-12 {
			if origin[i] < b.min[i] || origin[i] > b.max[i] {
				return -1
			}
			continue
		}
		inv := 1 / dir[i]
		t1 := (b.min[i] - origin[i]) * inv
		t2 := (b.max[i] - origin[i]) * inv
		if t1 > t2 {
			t1, t2 = t2, t1
		}
		if t1 > tmin {
			tmin = t1
		}
		if t2 < tmax {
			tmax = t2
		}
		if tmin > tmax {
			return -1
		}
	}
	if tmax < 0 {
		return -1
	}
	return tmin
}

// segmentBlocked — есть ли геометрия на отрезке p0..p1 (проверка LOS).
func (m *gameMap) segmentBlocked(p0, p1 vec3) bool {
	d := p1.sub(p0)
	l := d.length()
	if l < 1e-9 {
		return false
	}
	dir := d.scaled(1 / l)
	for i := range m.Colliders {
		if t := rayBoxT(p0, dir, aabb{vec3(m.Colliders[i].Min), vec3(m.Colliders[i].Max)}); t >= 0 && t <= l {
			return true
		}
	}
	return false
}

// raycast — ближайшая точка входа луча в геометрию (конец трассера).
func (m *gameMap) raycast(origin, dir vec3) (vec3, bool) {
	best := math.Inf(1)
	for i := range m.Colliders {
		if t := rayBoxT(origin, dir, aabb{vec3(m.Colliders[i].Min), vec3(m.Colliders[i].Max)}); t >= 0 && t < best {
			best = t
		}
	}
	if math.IsInf(best, 1) {
		return vec3{}, false
	}
	return origin.add(dir.scaled(best)), true
}
