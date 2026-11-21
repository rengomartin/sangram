package ws

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"arena/internal/game"
	"arena/internal/room"
)

func TestTwoPlayerWebSocketFlow(t *testing.T) {
	cfg := game.DefaultConfig()
	cfg.Countdown = 250 * time.Millisecond
	cfg.SnapshotRate = 60
	cfg.HeartbeatTimeout = 10 * time.Second
	cfg.DisconnectGrace = time.Second
	manager := room.NewManager(cfg)
	handler := NewHandler(manager, cfg, nil)
	server := httptest.NewServer(handler)
	defer server.Close()

	dial := func() *websocket.Conn {
		t.Helper()
		url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
		conn, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatal(err)
		}
		readType(t, conn, "hello", 2*time.Second)
		return conn
	}
	c1 := dial()
	defer c1.Close()
	c2 := dial()
	defer c2.Close()

	write(t, c1, map[string]any{"type": "create", "nickname": "Aldric"})
	welcome1 := readType(t, c1, "welcome", 2*time.Second)
	var w1 struct {
		PlayerID string        `json:"playerId"`
		Token    string        `json:"token"`
		Room     room.RoomView `json:"room"`
	}
	if err := json.Unmarshal(welcome1, &w1); err != nil {
		t.Fatal(err)
	}
	if len(w1.Room.Code) != 6 || w1.Token == "" {
		t.Fatalf("bad welcome: %s", welcome1)
	}

	write(t, c2, map[string]any{"type": "join", "nickname": "Bryn", "roomCode": w1.Room.Code})
	welcome2 := readType(t, c2, "welcome", 2*time.Second)
	var w2 struct {
		PlayerID string        `json:"playerId"`
		Token    string        `json:"token"`
		Room     room.RoomView `json:"room"`
	}
	if err := json.Unmarshal(welcome2, &w2); err != nil {
		t.Fatal(err)
	}
	if w2.Room.YourSlot != 1 {
		t.Fatalf("second player slot = %d", w2.Room.YourSlot)
	}

	// The first player sees the roster update.
	waitRoomPlayers(t, c1, 2, 2*time.Second)

	for _, pair := range []struct {
		c    *websocket.Conn
		char string
	}{
		{c1, "knight"}, {c2, "duelist"},
	} {
		write(t, pair.c, map[string]any{"type": "select", "character": pair.char})
		write(t, pair.c, map[string]any{"type": "confirm", "confirmed": true})
	}
	write(t, c1, map[string]any{"type": "ready", "ready": true})
	write(t, c2, map[string]any{"type": "ready", "ready": true})

	// Both clients should receive a synchronized countdown and then combat.
	state1 := waitStatePhase(t, c1, room.PhaseCountdown, 2*time.Second)
	state2 := waitStatePhase(t, c2, room.PhaseCountdown, 2*time.Second)
	if state1.Match == nil || state2.Match == nil {
		t.Fatal("countdown state missing match")
	}
	waitStatePhase(t, c1, room.PhasePlaying, 3*time.Second)
	waitStatePhase(t, c2, room.PhasePlaying, 3*time.Second)

	write(t, c1, map[string]any{
		"type": "input", "seq": 1, "mx": 1, "my": 0, "block": false,
		"attackSeq": 0, "dodgeSeq": 0,
	})
	startX := state1.Match.Fighters[0].X
	deadline := time.Now().Add(3 * time.Second)
	var seen1, seen2 room.StateView
	for time.Now().Before(deadline) {
		env := readEnvelope(t, c1, 2*time.Second)
		var e struct {
			Type  string         `json:"type"`
			State room.StateView `json:"state"`
		}
		_ = json.Unmarshal(env, &e)
		if e.Type == "state" && e.State.Match != nil {
			seen1 = e.State
			if e.State.Match.Fighters[0].X > startX+20 {
				break
			}
		}
	}
	if seen1.Match == nil || seen1.Match.Fighters[0].X <= startX+20 {
		t.Fatal("client input did not move the authoritative player")
	}
	for i := 0; i < 20; i++ {
		env := readEnvelope(t, c2, 2*time.Second)
		var e struct {
			Type  string         `json:"type"`
			State room.StateView `json:"state"`
		}
		_ = json.Unmarshal(env, &e)
		if e.Type == "state" && e.State.Match != nil {
			seen2 = e.State
			if e.State.Match.Fighters[0].X > startX+20 {
				break
			}
		}
	}
	if seen2.Match == nil || seen2.Match.Fighters[0].X <= startX+20 {
		t.Fatal("second client did not receive synchronized movement")
	}
	if seen1.Match.Fighters[0].Health != seen2.Match.Fighters[0].Health {
		t.Fatal("health diverged between clients")
	}

	// A malformed but valid-shaped message does not crash the session.
	write(t, c1, map[string]any{"type": "select", "character": "dragon"})
	readType(t, c1, "error", 2*time.Second)
}

func TestInvalidRoomCodeReturnsClearError(t *testing.T) {
	cfg := game.DefaultConfig()
	manager := room.NewManager(cfg)
	server := httptest.NewServer(NewHandler(manager, cfg, nil))
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	readType(t, conn, "hello", 2*time.Second)
	write(t, conn, map[string]any{"type": "join", "nickname": "Lost", "roomCode": "ZZZZZZ"})
	payload := readType(t, conn, "error", 2*time.Second)
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(payload, &e)
	if e.Code != "room_not_found" {
		t.Fatalf("error code = %q", e.Code)
	}
}

func write(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	_ = c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := c.WriteJSON(v); err != nil {
		t.Fatal(err)
	}
}

func readEnvelope(t *testing.T, c *websocket.Conn, timeout time.Duration) []byte {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func readType(t *testing.T, c *websocket.Conn, typ string, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data := readEnvelope(t, c, timeout)
		var header struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &header); err != nil {
			t.Fatalf("bad json: %v", err)
		}
		if header.Type == typ {
			return data
		}
	}
	t.Fatalf("timed out waiting for %s", typ)
	return nil
}

func waitRoomPlayers(t *testing.T, c *websocket.Conn, count int, timeout time.Duration) room.RoomView {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data := readEnvelope(t, c, timeout)
		var env struct {
			Type string        `json:"type"`
			Room room.RoomView `json:"room"`
		}
		_ = json.Unmarshal(data, &env)
		if env.Type == "room" && len(env.Room.Players) == count {
			return env.Room
		}
	}
	t.Fatal("roster did not update")
	return room.RoomView{}
}

func waitStatePhase(t *testing.T, c *websocket.Conn, phase string, timeout time.Duration) room.StateView {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		data := readEnvelope(t, c, timeout)
		var env struct {
			Type  string         `json:"type"`
			State room.StateView `json:"state"`
		}
		_ = json.Unmarshal(data, &env)
		if env.Type == "state" && env.State.Phase == phase {
			return env.State
		}
	}
	t.Fatalf("timed out waiting for state phase %s", phase)
	return room.StateView{}
}
