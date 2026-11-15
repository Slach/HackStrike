package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// /api/map отдаёт ровно встроенную карту (bytes-в--bytes), /healthz — ok.
func TestHTTPMapAndHealthz(t *testing.T) {
	r := newRoom(mustParseEmbeddedMap(t))
	srv := httptest.NewServer(newHTTPMux(r))
	defer srv.Close()
	client := srv.Client()

	resp, err := client.Get(srv.URL + "/api/map")
	if err != nil {
		t.Fatalf("GET /api/map: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != string(h2dm1JSON) {
		t.Fatalf("/api/map body differs from embedded map (%d vs %d bytes)", len(body), len(h2dm1JSON))
	}
	if _, err := parseGameMap(body); err != nil {
		t.Fatalf("served map must parse: %v", err)
	}

	hc, err := client.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer hc.Body.Close()
	if hc.StatusCode != http.StatusOK {
		t.Fatalf("healthz status = %d", hc.StatusCode)
	}
}
