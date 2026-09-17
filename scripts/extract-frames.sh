#!/usr/bin/env bash
# Extract frames from a boss-fight video for pattern study.
# Usage: ./extract-frames.sh <video.mp4> <outdir> [fps] [start] [end]
#   fps    frames per second to extract (default 2)
#   start  seconds offset to start at (default 0)
#   end    seconds offset to stop at (default = full video)
set -euo pipefail
VID="$1"; OUT="$2"; FPS="${3:-2}"; START="${4:-0}"; END="${5:-}"
mkdir -p "$OUT"
ARGS=(-y -ss "$START")
[ -n "$END" ] && ARGS+=(-t "$((END - START))")
ffmpeg "${ARGS[@]}" -i "$VID" -vf "fps=$FPS" -q:v 3 "$OUT/frame_%04d.jpg" 2>/dev/null
echo "wrote $(ls "$OUT" | wc -l) frames to $OUT (fps=$FPS, from ${START}s)"
