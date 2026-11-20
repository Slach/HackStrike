package main

import (
	"log"
	"math"
	"sort"
	"time"
)

// Стрельба (ГДД §9.4): hitscan из глаз. Попадание засчитано, если луч
// пересекает AABB цели — текущий ИЛИ отмотанный на rewindTicks назад
// (клиент целится по интерполированной позиции ~66 мс в прошлом), либо
// цель в конусе ~2° (мягкий bullet magnetism — «доворачиваются пули, а не
// прицел»). LOS до центра цели должен быть чист от геометрии. Friendly fire ON.
// shotHearRadius — пеленг выстрелов (M6 §17.1): «слышимость» союзником, м.
const shotHearRadius = 28.0

const magnetismHalfAngle = 2.0 * math.Pi / 180

var magnetismCos = math.Cos(magnetismHalfAngle)

// rewindTicks — на сколько тиков отматывать AABB цели: ~100 мс при 30 Гц
// (ред. 2026-11-17: интерполяция клиента снижена 100→66 мс, ГДД §15.13 —
// отмотка синхронизирована: 66 мс буфер + сетевой/тиковый запас; было 4
// под прежние ~100 мс).
const rewindTicks = 3

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
// У хакера оружие M2 — нож: fire = удар melee (§12.1). Джекнутое тело стоит
// у терминала беззащитным (§5.4) — не стреляет.
func (w *world) handleFire(pl *player, msg message) {
	if !pl.alive || pl.jacked {
		return
	}
	_, st := classOr(pl.cls)
	wpn := st.weapon
	now := w.now()
	if pl.lastShot != (time.Time{}) && now.Before(pl.lastShot.Add(wpn.interval-rateEpsilon)) {
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
		if w.segmentBlockedAll(origin, c.center) {
			continue // за укрытием (стена или закрытая дверь)
		}
		hit = c.pl
		to = origin.add(dir.scaled(c.tAlong))
		break
	}
	if hit == nil {
		// Трассер до геометрии или закрытой двери; чистое небо невозможно
		// (крыша), но на всякий случай — 100 м от стрелка.
		if end, ok := w.raycastAll(origin, dir); ok {
			to = end
		} else {
			to = origin.add(dir.scaled(100))
		}
	}

	killed := false
	if hit != nil {
		killed = w.damage(pl, hit, classStatsOf(pl.cls).weapon.damage)
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
	w.reportBearing(pl)
	if killed {
		w.sendTo(hit.id, message{"t": "death", "by": pl.id, "respawnAt": hit.respawnAt.UnixMilli()})
	}
}

// reportBearing — пеленг выстрела (M6 §17.1): живым СОЮЗНИКАМ стрелка в
// радиусе слышимости — сектор направления на стрелка + дистанция. Замена
// позиционного звука: в браузере на телефоне «откуда стреляют» не слышно.
// Врагам не шлём (пеленг — командный бафф), стрелку тоже (он знает, где он).
func (w *world) reportBearing(shooter *player) {
	for _, pl := range w.players {
		if pl.id == shooter.id || !pl.alive || pl.team != shooter.team {
			continue
		}
		dx := shooter.pos[0] - pl.pos[0]
		dz := shooter.pos[2] - pl.pos[2]
		d := math.Sqrt(dx*dx + dz*dz + (shooter.pos[1]-pl.pos[1])*(shooter.pos[1]-pl.pos[1]))
		if d > shotHearRadius || d < 0.5 {
			continue
		}
		w.sendTo(pl.id, message{
			"t":   "report",
			"by":  shooter.id,
			"dir": math.Round(math.Atan2(dx, dz)*100) / 100,
			"d":   math.Round(d*10) / 10,
		})
	}
}

// classStatsOf — статы класса (с дефолтом для мусорного cls).
func classStatsOf(cls string) classStats {
	_, st := classOr(cls)
	return st
}

// damage — урон (friendly fire ON: союзники получают урон так же).
// dmg передаёт вызывающий (классовое оружие).
// Возвращает true, если жертва умерла.
func (w *world) damage(shooter, victim *player, dmg int) bool {
	if !victim.alive {
		return false
	}
	// §16.6: урон по вскрывающему прерывает канал «вскрываем»
	if w.physafe.chKind != "" && w.physafe.chBy == victim.id {
		w.cancelSafeChannel()
	}
	victim.hp -= dmg
	if victim.hp > 0 {
		return false
	}
	victim.hp = 0
	victim.alive = false
	victim.respawnAt = w.now().Add(respawnDelay)
	if victim.carry {
		w.dropSafe() // §16.6: смерть носителя — сейф падает на месте
	}
	w.jackout(victim) // смерть хакера = авто-джек-аут (§12.1)
	victim.items = nil // §16.1: MEM деки умирает с хакером
	w.scores[shooter.team]++
	shooter.frags++ // личный счёт для таблицы конца матча
	// Смерти в логе не было: «непонятный» jackout у джекнутого хакера не
	// отличить от ручного CTRL/CMD+ALT+DEL (баг-репорт владельца 2026-11-16).
	log.Printf("combat: kill player %d -> player %d", shooter.id, victim.id)
	return true
}

// envDamage — урон от среды (§14.2): газовая ловушка (и будущая лава).
// Копия damage без стрелка: hp → смерть → respawnAt +5 с + авто-джек-аут
// (хакер в газе сгорел в meatspace) + death by=0 жертве + broadcast envkill
// (киллфид всем: death исторически приватен, §14.3). owner — trojan-владелец
// устройства-ловушки (0 = нейтрали): при owner>0 и owner≠victim +1 команде
// владельца (решение владельца: ценность взлома; «сам в свой газ» не
// фармится), иначе счёт чист. shot-сообщения нет.
// Возвращает true, если жертва умерла.
func (w *world) envDamage(victim *player, dmg int, owner uint64) bool {
	if !victim.alive {
		return false
	}
	// §16.6: лава/газ по вскрывающему прерывает канал (гейт лавы у сейфа)
	if w.physafe.chKind != "" && w.physafe.chBy == victim.id {
		w.cancelSafeChannel()
	}
	victim.hp -= dmg
	if victim.hp > 0 {
		return false
	}
	victim.hp = 0
	victim.alive = false
	victim.respawnAt = w.now().Add(respawnDelay)
	if victim.carry {
		w.dropSafe() // §16.6: смерть носителя в лаве — сейф падает на месте
	}
	w.jackout(victim)
	victim.items = nil // §16.1: MEM деки умирает с хакером
	if owner != 0 && owner != victim.id {
		if op, ok := w.players[owner]; ok {
			w.scores[op.team]++
			op.frags++ // ловушка убила — фраг владельцу (таблица §3.3)
		}
	}
	w.sendTo(victim.id, message{"t": "death", "by": uint64(0), "respawnAt": victim.respawnAt.UnixMilli()})
	w.broadcast(message{"t": "envkill", "victim": victim.id, "owner": owner})
	log.Printf("combat: envkill player %d (trap owner %d)", victim.id, owner)
	return true
}
