package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"arena/internal/game"
	"arena/internal/server"
)

func main() {
	cfg := game.DefaultConfig()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	if !strings.HasPrefix(port, ":") {
		port = ":" + port
	}
	var allowedOrigins []string
	if raw := os.Getenv("ALLOWED_ORIGINS"); raw != "" {
		for _, value := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				allowedOrigins = append(allowedOrigins, trimmed)
			}
		}
	}

	app := server.New(cfg, allowedOrigins)
	app.LogConfig()
	httpServer := &http.Server{
		Addr:              port,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		log.Printf("listening on http://localhost%s", port)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	log.Println("arena closed")
}
