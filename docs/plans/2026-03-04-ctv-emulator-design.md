# CTV Emulator Platform — Design Document

**Date:** 2026-03-04
**Architecture:** Master + Worker (child_process.fork)

## Overview

Headless CTV emulator that reproduces OTT video playback, VAST advertising, OpenRTB bidding, and tracking events. Supports 200+ parallel sessions.

## Architecture

```
Master Process (Fastify)
├── API Server (POST/GET/DELETE sessions, /metrics, /health)
├── Session Scheduler (least-loaded worker selection)
├── Worker Manager (fork, restart after 100 sessions)
└── Metrics Registry (prom-client)

Worker Processes (child_process.fork)
├── Playwright Chromium browser
├── Session instances (default 10 per worker)
└── Network interceptor (request classification + NDJSON logging)
```

IPC via Node.js `process.send()` / `process.on('message')`.

## Project Structure

```
src/
├── master/        — server, scheduler, worker-manager, metrics
├── worker/        — worker entry, session state machine, browser pool, network interceptor
├── engines/       — rtb-adapter, vast-resolver, ad-timeline, tracking-engine
├── emulation/     — device-profiles, network-profiles
├── shared/        — types, zod schemas, pino logger, constants
└── index.ts
public/player.html — Shaka Player (ad-video + content-video elements)
fixtures/          — VAST XML test files
tests/             — unit, integration, load
```

## Session State Machine

```
CREATED → INITIALIZING → RTB_REQUESTING → VAST_RESOLVING → AD_LOADING → AD_PLAYING → CONTENT_PLAYING → STOPPING → STOPPED
```

Error states: ERROR_VAST, ERROR_MEDIA, ERROR_NETWORK, ERROR_TIMEOUT.
Retry policy: max 2 retries before STOPPED.

## Session Flow

1. `POST /api/sessions` with device config (validated via Zod)
2. Scheduler picks least-loaded worker
3. Worker creates Playwright browser context (user-agent, viewport, geo, timezone)
4. RTB adapter sends OpenRTB 2.6 bid request (device.devicetype=7)
5. VAST resolver parses response XML, follows wrappers (max 5, 3s/hop timeout)
6. MediaFile loaded into Shaka Player via player.html
7. Ad Timeline fires quartile events at correct timestamps (±1.5s jitter)
8. Tracking Engine sends events with idempotency keys (fire exactly once)
9. After ad: play content stream
10. Network interceptor classifies all requests (rtb/vast/media/tracking/content) → NDJSON

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sessions | Create session |
| GET | /api/sessions | List sessions |
| GET | /api/sessions/:id | Session status |
| DELETE | /api/sessions/:id | Stop session |
| POST | /api/sessions/batch | Batch create |
| GET | /api/workers | Worker stats |
| GET | /metrics | Prometheus |
| GET | /health | Healthcheck |

## Key Constraints

- MAX_SESSIONS: 200, MAX_EVENTS: 10000
- Memory target: ~40MB/session
- Worker restart after 100 sessions
- Timeouts: RTB 2000ms, VAST 3000ms, MEDIA 5000ms
- All inputs Zod-validated, sensitive data masked in logs

## Tech Stack

Node.js 20 LTS, TypeScript strict, Playwright Chromium, Shaka Player 4.x, Fastify, Zod, Pino, prom-client, Docker (mcr.microsoft.com/playwright base)

## Deployment

Docker Compose with `ctv-emulator` service on port 3000. Volumes: logs, fixtures. Environment variables for all tunable parameters.
