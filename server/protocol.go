package main

import (
	"math"
	"strings"
)

// message — один JSON-кадр в обе стороны; "t" дискриминирует вид (§9.2).
type message map[string]any

func num(m message, key string) float64 {
	v, ok := m[key].(float64)
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func str(m message, key string) string {
	s, _ := m[key].(string)
	return s
}

func keyBool(keys map[string]any, key string) bool {
	v, ok := keys[key].(float64)
	return ok && v != 0
}

// sanitizeName — имя игрока: без краёв, максимум 24 руны, непустое.
func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 24 {
		s = string(r[:24])
	}
	if s == "" {
		s = "player"
	}
	return s
}
