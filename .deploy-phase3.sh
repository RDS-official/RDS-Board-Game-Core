#!/bin/bash
set -e
cd /d/RDS/RDS-Board-Core
git add -A
git commit -m "feat(phase-3): guest auto-redial + host-away overlay + idle room sweep" -m "- netSession: guest auto redial (2.5s x40), presence host-return triggers channel rebuild
- webrtc-transport: host mesh tears down failed/disconnected stale pcs so redial SDP is not swallowed
- main.ts: host-away fullscreen overlay with 5min countdown; guest reconnecting/reconnected notices
- server: sweepRooms idle room reclaim (all-offline>10min or 6h inactive), 60s interval"
git checkout main
git merge --no-ff phase-3-resilience -m "merge: phase-3-resilience"
git push origin main
