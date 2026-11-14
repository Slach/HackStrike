package main

import (
	"math"
	"sort"
	"time"
)

// Стрельба (ГДД §9.4): hitscan из глаз. Попадание засчитано, если луч
// пересекает AABB цели — текущий ИЛИ отмотанный на rewindTicks назад
// (клиент целится по интерполированной позиции ~100 мс в прошлом), либо
// цель в конусе ~2° (мягкий bullet magnetism — «доворачиваются пули, а не
// прицел»). LOS до центра цели должен быть чист от геометрии. Friendly fire ON.
const magnetismHalfAngle = 2.0 * math.Pi / 180

var magnetismCos = math.Cos(magnetismHalfAngle)

// rewindTicks — на сколько тиков отматывать AABB цели: ~133 мс при 30 Гц
// (интерполяция клиента ~100 мс + джиттер).
const rewindTicks = 4

// rateEpsilon — допуск к темпу оружия на сетевой джиттер (полтика 30 Гц).
const rateEpsilon = 15 * time.Millisecond

func clampPitch(p float64) float64 {
	const maxPitch = 89.0 * math.Pi / 180
	return math.Max(-maxPitch, math.Min(maxPitch, p))
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

// aimDir — направление взгляда из yaw/pitch (LH-конвенция Babylon:
// yaw 0 = +Z, положительный по часовой сверху; pitch +вверх).
func aimDir(yaw, pitch float64) vec3 {
	return vec3{math.Sin(yaw) * math.Cos(pitch), math.Sin(pitch), math.Cos(yaw) * math.Cos(pitch)}.norm()
}

// handleFire — intent автоогня: валидация темпа по оружию, затем hitscan.
func (w *world) handleFire(pl *player, msg message) {
	if !pl.alive {
		return
	}
	_, st := classOr(pl.cls)
	now := w.now()
	if pl.lastShot != (time.Time{}) && now.Before(pl.lastShot.Add(st.weapon.interval-rateEpsilon)) {
		return // быстрее темпа оружия
	}
	pl.lastShot = now
	w.fire(pl, num(msg, "yaw"), num(msg, "pitch"))
}

// fire — один выстрел: конус → ближайшая вдоль луча цель с чистым LOS →
// урон; broadcast "shot" всем (hit null при промахе).
func (w *world) fire(pl *player, yaw, pitch float64) {
	pl.yaw, pl.pitch = yaw, pitch
	origin := pl.pos.add(vec3{0, eyeHeight, 0})
	dir := aimDir(yaw, pitch)

	type candidate struct {
		pl     *player
		center vec3
		tAlong float64 // точка входа луча в AABB (или проекция центра)
	}
	var cands []candidate
	for _, p := range w.players {
		if p.id == pl.id || !p.alive {
			continue
		}
		center := p.pos.add(vec3{0, playerHeight / 2, 0})
		rel := center.sub(origin)
		dist := rel.length()
		if dist < 1e-6 {
			cands = append(cands, candidate{p, center, 0})
			continue
		}
		// Геометрия: вход луча в текущий AABB и в AABB rewindTicks назад.
		tNow := rayBoxT(origin, dir, playerBoxAt(p.pos))
		tRew := rayBoxT(origin, dir, playerBoxAt(p.histPosAt(rewindTicks)))
		inCone := rel.dot(dir)/dist >= magnetismCos
		if tNow < 0 && tRew < 0 && !inCone {
			continue // мимо тела (и сейчас, и 133 мс назад) и вне конуса доворота
		}
		tAlong := rel.dot(dir)
		if tNow >= 0 && (tAlong < 0 || tNow < tAlong) {
			tAlong = tNow
		}
		if tRew >= 0 && tRew < tAlong {
			tAlong = tRew
		}
		cands = append(cands, candidate{p, center, tAlong})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].tAlong < cands[j].tAlong })

	var hit *player
	to := vec3{}
	for _, c := range cands {
		if w.m.segmentBlocked(origin, c.center) {
			continue // за укрытием
		}
		hit = c.pl
		to = origin.add(dir.scaled(c.tAlong))
		break
	}
	if hit == nil {
		// Трассер до геометрии; чистое небо невозможно (крыша), но на всякий
		// случай — 100 м от стрелка.
		if end, ok := w.m.raycast(origin, dir); ok {
			to = end
		} else {
			to = origin.add(dir.scaled(100))
		}
	}

	killed := false
	if hit != nil {
		killed = w.damage(pl, hit)
	}
	shot := message{
		"t":    "shot",
		"by":   pl.id,
		"hit":  nil, // null при промахе — поле присутствует всегда (§9.2)
		"from": origin.round2(),
		"to":   to.round2(),
	}
	if hit != nil {
		shot["hit"] = hit.id
	}
	w.broadcast(shot)
	if killed {
		w.sendTo(hit.id, message{"t": "death", "by": pl.id, "respawnAt": hit.respawnAt.UnixMilli()})
	}
}

// damage — урон (friendly fire ON: союзники получают урон так же).
// Возвращает true, если жертва умерла.
func (w *world) damage(shooter, victim *player) bool {
	if !victim.alive {
		return false
	}
	_, st := classOr(shooter.cls)
	victim.hp -= st.weapon.damage
	if victim.hp > 0 {
		return false
	}
	victim.hp = 0
	victim.alive = false
	victim.respawnAt = w.now().Add(respawnDelay)
	w.scores[shooter.team]++
	return true
}
