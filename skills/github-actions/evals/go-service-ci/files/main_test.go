package main

import (
	"net/http/httptest"
	"testing"
)

func TestHandler(t *testing.T) {
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest("GET", "/ping", nil))
	if rec.Body.String() != "pong" {
		t.Fatalf("got %q", rec.Body.String())
	}
}
