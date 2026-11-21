package ws

import (
	"crypto/rand"
	"encoding/hex"
)

func newConnID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("websocket entropy failure")
	}
	return "c_" + hex.EncodeToString(b)
}
