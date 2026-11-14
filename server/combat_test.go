package main

import (
	"math"
	"testing"
	"time"
)

// aimLevelY — высота ног цели, при которой центр её AABB совпадает
// с высотой глаз стрелка, стоящего на полу (y=1).
const aimLevelY = 1 + eyeHeight - playerHeight/2

// Боевая мини-арена: только пол, цель ставим руками. Глаза стрелка на
// y = 1 + 1.6 = 2.6; цель ставим так, чтобы центр её AABB (ноги + 0.9)
// был на высоте глаз — тогда угол к цели определяется только смещением по X.
func combatWorld(t *testing.T) (*world, *player, *player, *time.Time) {
	t.Helper()
	m := &gameMap{
		Name:   "t",
		Bounds: [3]float64{40, 8, 40},
		Colliders: []collider{
			{Min: [3]float64{0, 0, 0}, Max: [3]float64{40, 1, 40}, Kind: "floor"},
		},
	}
	w := newWorld(m)
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }

	shooter := w.addPlayer(1, "shooter", "sniper", -1)
	victim := w.addPlayer(2, "victim", "heavy", -1)
	shooter.team, victim.team = 0, 0 // союзники: friendly fire ON
	shooter.pos = vec3{0, 1, 0}
	victim.pos = vec3{0, aimLevelY, 10} // центр AABB на высоте глаз
	victim.hp = 200
	w.takeOut() // сбросить welcome
	return w, shooter, victim, &clock
}

func shots(w *world) []message {
	var res []message
	for _, om := range w.takeOut() {
		if om.msg["t"] == "shot" {
			res = append(res, om.msg)
		}
	}
	return res
}

// Конус ~2°: смещение 0.25 м на 10 м (~1.4°) — попадание, 0.6 м (~3.4°) — мимо.
func TestFireCone(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)

	// Внутри конуса.
	victim.pos = vec3{0.25, aimLevelY, 10}
	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != victim.id {
		t.Fatalf("target 1.4° off-axis must be hit, got %+v", s)
	}
	if want := 200 - 150; victim.hp != want {
		t.Fatalf("sniper damage: victim hp = %d, want %d", victim.hp, want)
	}
	// Точка попадания — на луче, близко к цели.
	to := s[0]["to"].(vec3)
	if math.Abs(to[2]-10) > 1.0 || math.Abs(to[0]) > 0.3 {
		t.Fatalf("hit point %v should be near the target", to)
	}

	// Вне конуса и мимо AABB.
	victim.pos = vec3{0.6, aimLevelY, 10}
	w.fire(shooter, 0, 0)
	s = shots(w)
	if len(s) != 1 || s[0]["hit"] != nil {
		t.Fatalf("target 3.4° off-axis must be missed, got %+v", s)
	}
	if victim.hp != 50 {
		t.Fatalf("miss must not deal damage, hp=%d", victim.hp)
	}
}

// LOS: цель точно по оси, но за стеной — попадания нет.
func TestFireLOSBlocked(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)
	w.m.Colliders = append(w.m.Colliders,
		collider{Min: [3]float64{-1, 1, 5}, Max: [3]float64{1, 3, 6}, Kind: "wall"})
	victim.pos = vec3{0, aimLevelY, 10}

	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != nil {
		t.Fatalf("target behind a wall must not be hit, got %+v", s)
	}
	if victim.hp != 200 {
		t.Fatalf("no damage through a wall, hp=%d", victim.hp)
	}
}

// Реалистичный бой: оба на одном полу, цель в 8 м. Прицел в голову/грудь/ноги
// геометрически пересекает AABB тела, но угол к ЦЕНТРУ больше 2° — раньше
// такие выстрелы отклонялись (симптом «стреляю в упор — не умирает»).
// Теперь луч∩AABB засчитывается безусловно.
func TestFireBodyParts(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)
	victim.pos = vec3{0, 1, 8} // стоит на том же полу, ноги y=1

	cases := []struct {
		name  string
		aimY  float64
		want  bool
	}{
		{"ноги (y+0.3)", 1 + 0.3, true},
		{"центр (y+0.9)", 1 + 0.9, true},
		{"грудь (y+1.3)", 1 + 1.3, true},
		{"голова (y+1.6)", 1 + 1.6, true},
		{"над головой (y+2.0)", 1 + 2.0, false},
	}
	for _, c := range cases {
		victim.hp = 200
		victim.alive = true
		pitch := math.Atan2(c.aimY-(1+eyeHeight), 8)
		w.fire(shooter, 0, pitch)
		s := shots(w)
		hit := len(s) == 1 && s[0]["hit"] == victim.id
		if hit != c.want {
			t.Fatalf("%s: want hit=%v, got %+v", c.name, c.want, s)
		}
	}
}

// Магнитизм (ГДД §3.2 «доворачиваются пули»): промах 0.45 м на 15 м — AABB
// (±0.3) не задет, но конус 2° (0.52 м на 15 м) доворачивает попадание.
func TestFireMagnetism(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)
	victim.pos = vec3{0, aimLevelY, 15}
	w.fire(shooter, math.Atan2(0.45, 15), 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != victim.id {
		t.Fatalf("near-miss inside the magnetism cone must be hit, got %+v", s)
	}
}

// Lag compensation: клиент целится по интерполированной позиции ~100 мс в
// прошлом. Стрейф-рывок цели на 0.65 м между тиками — выстрел по старой
// позиции должен попадать через отмотку AABB.
func TestFireRewindMovingTarget(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)
	victim.pos = vec3{0, aimLevelY, 10}
	for i := 0; i < 6; i++ { // набираем историю позиций
		w.simulateTick()
	}
	victim.pos = vec3{0.65, aimLevelY, 10} // рывок вбок; текущий AABB луч x=0 не задевает
	w.takeOut()
	w.fire(shooter, 0, 0) // стрелок целился в старую (интерполированную) позицию
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != victim.id {
		t.Fatalf("shot at the interpolated (old) position must hit via rewind, got %+v", s)
	}
}

// Friendly fire ON: союзник получает урон и может быть убит.
func TestFriendlyFire(t *testing.T) {
	w, shooter, victim, clock := combatWorld(t)
	if shooter.team != victim.team {
		t.Fatalf("setup: same team expected")
	}
	victim.pos = vec3{0, aimLevelY, 10}

	w.fire(shooter, 0, 0) // 150 урона
	if victim.hp != 50 || !victim.alive {
		t.Fatalf("after first shot: hp=%d alive=%v", victim.hp, victim.alive)
	}
	*clock = clock.Add(2 * time.Second)
	w.fire(shooter, 0, 0) // добил (200-150-150<0)
	if victim.alive || victim.hp != 0 {
		t.Fatalf("teammate must die: hp=%d alive=%v", victim.hp, victim.alive)
	}
	foundDeath, foundShot := false, false
	for _, om := range w.takeOut() {
		if om.msg["t"] == "death" && om.to == victim.id {
			foundDeath = true
			if om.msg["by"] != shooter.id {
				t.Fatalf("death.by = %v", om.msg["by"])
			}
		}
		if om.msg["t"] == "shot" && om.msg["hit"] == victim.id {
			foundShot = true
		}
	}
	if !foundDeath || !foundShot {
		t.Fatalf("want death to victim and broadcast shot, death=%v shot=%v", foundDeath, foundShot)
	}
	if w.scores != [2]int{1, 0} {
		t.Fatalf("killer team score = %v, want [1 0]", w.scores)
	}
}

// Рейт-лимит огня: темп валидируется по оружию (снайпер 1 выстрел / 1.2 с).
func TestFireRateLimit(t *testing.T) {
	w, shooter, victim, clock := combatWorld(t)
	victim.pos = vec3{0, aimLevelY, 10}

	// Первый выстрел — принят.
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if hp := victim.hp; hp != 50 {
		t.Fatalf("first shot must land, hp=%d", hp)
	}

	// Слишком рано (интервал 1.2 с, допуск 15 мс) — отброшен.
	*clock = clock.Add(1100 * time.Millisecond)
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if victim.hp != 50 {
		t.Fatalf("shot inside weapon cooldown must be rejected, hp=%d", victim.hp)
	}

	// По истечении интервала — принят и добивает (200-2*150<0).
	*clock = clock.Add(120 * time.Millisecond) // итого 1.22 с
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if victim.alive {
		t.Fatalf("second sniper shot must kill, hp=%d", victim.hp)
	}
	w.takeOut()

	// Мёртвый не стреляет: убиваем самого стрелка.
	shooter.hp = 1
	w.damage(victim, shooter)
	if shooter.alive {
		t.Fatalf("setup: shooter must be dead")
	}
	*clock = clock.Add(2 * time.Second)
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if n := len(shots(w)); n != 0 {
		t.Fatalf("dead player must not fire, got %d shots", n)
	}

	// Бёрст в один момент времени: принят только первый.
	reviver := w.addPlayer(3, "r", "sniper", -1)
	reviver.pos = vec3{0, 1, 5}
	w.takeOut()
	for i := 0; i < 5; i++ {
		w.handleFire(reviver, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	}
	if n := len(shots(w)); n != 1 {
		t.Fatalf("burst of 5 fires at one instant: want 1 accepted, got %d", n)
	}
}

// Ближайшая цель вдоль луча: два врага в конусе, засчитывается ближний.
func TestNearestTargetAlongRay(t *testing.T) {
	w, shooter, _, _ := combatWorld(t)
	near := w.addPlayer(3, "near", "assault", -1)
	far := w.addPlayer(4, "far", "assault", -1)
	w.takeOut()
	near.pos = vec3{0, aimLevelY, 8}
	far.pos = vec3{0, aimLevelY, 20}

	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != near.id {
		t.Fatalf("nearest target must be hit, got %+v", s)
	}
	if far.hp != 125 { // (локальные жертвы этого теста — assault, 1 выстрел = смерть
		t.Fatalf("far target must be untouched, hp=%d", far.hp)
	}
}
