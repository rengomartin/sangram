// Package web embeds the browser client so the arena can ship as one binary.
package web

import "embed"

//go:embed index.html css js fonts favicon.svg
var FS embed.FS
