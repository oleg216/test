# CTV Emulator — Логіка роботи та архітектура

**Дата створення:** 2026-03-05
**Останнє оновлення:** 2026-03-05
**Проект:** `/var/oleg216-test/`

---

## Мета

Headless CTV-емулятор, який імітує реальні Smart TV пристрої (AndroidTV, Tizen/Samsung, WebOS/LG) і генерує відео-рекламний трафік через OpenRTB 2.6. Призначений для тестування DSP — відправка bid request'ів, отримання VAST-відповідей, програвання відео, відправка tracking events.

---

## Архітектура (Master → Workers)

```
API Client (curl / UI / script)
    │
    ▼
Master Process (Fastify, port 3000)
├── POST /api/sessions         — створити сесію
├── POST /api/sessions/batch   — батч до 50 сесій
├── GET  /api/sessions         — список сесій
├── GET  /api/sessions/:id     — статус сесії
├── DELETE /api/sessions/:id   — зупинити сесію
├── GET  /api/workers          — інфо про воркерів
├── GET  /metrics              — Prometheus метрики
└── GET  /health               — healthcheck
    │
    │ IPC (process.send / process.on)
    ▼
Worker Processes (до 20 воркерів, по 10 сесій кожен)
├── Playwright Chromium (headless, --no-sandbox)
├── Browser Context per session (UA, viewport, geo, timezone)
├── Network Interceptor (класифікація запитів)
└── Session State Machine
```

**Ліміти:**
- MAX_SESSIONS: 200
- MAX_WORKERS: 20
- SESSIONS_PER_WORKER: 10
- Worker рестарт після 100 оброблених сесій (memory management)

---

## Повний цикл сесії

### State Machine

```
CREATED → INITIALIZING → RTB_REQUESTING → VAST_RESOLVING → AD_LOADING → AD_PLAYING → CONTENT_PLAYING → STOPPING → STOPPED
```

Error states: `ERROR_VAST`, `ERROR_MEDIA`, `ERROR_NETWORK`, `ERROR_TIMEOUT`
Retry: до 2 спроб на RTB та media loading.

### Покроковий флоу

#### 1. INITIALIZING
- Playwright створює `BrowserContext` з параметрами девайсу:
  - `userAgent` — реальний UA для конкретної моделі TV
  - `viewport` — 1920×1080 (Full HD)
  - `timezone` — зона US (New York, Chicago, LA, etc.)
  - `geolocation` — координати US міст з jitter'ом
- Відкриває `public/player.html` через `file://`
- Чекає `window.__playerReady === true` (Shaka Player ініціалізований)

#### 2. RTB_REQUESTING
- `rtb-adapter.ts` будує OpenRTB 2.6 bid request:
  ```json
  {
    "id": "uuid",
    "at": 1,
    "tmax": 2000,
    "cur": ["USD"],
    "imp": [{
      "id": "hex8chars",
      "video": {
        "mimes": ["video/mp4", "application/x-mpegURL"],
        "protocols": [2, 3, 5, 6],
        "w": 1920, "h": 1080,
        "linearity": 1,
        "startdelay": 0,
        "plcmt": 1,
        "minduration": 5,
        "maxduration": 30
      },
      "bidfloor": 2.0,
      "bidfloorcur": "USD",
      "displaymanager": "Google Interactive Media Ads",
      "displaymanagerver": "3.30.3"
    }],
    "source": { "fd": 0, "tid": "request-uuid" },
    "regs": { "coppa": 0, "ext": { "gdpr": 0, "us_privacy": "1---" } },
    "app": { "bundle", "name", "storeurl", "ver", "publisher", "content" },
    "device": { "ua", "devicetype": 3, "make", "model", "ip", "ifa", "os", "osv", "language", "connectiontype", "geo" }
  }
  ```
- Відправляє POST на `rtbEndpoint` з header `x-openrtb-version: 2.6`
- Timeout: 2000ms через `AbortController`
- HTTP 204 = no-bid (нормальна поведінка)
- Витягує `bid.adm` (VAST XML) з першого seatbid
- **Валідація adm**: перевіряє що це XML і що містить `<VAST>` — якщо DSP повернув banner HTML, логує warning і повертає null

#### 3. VAST_RESOLVING
- `vast-resolver.ts` парсить VAST XML:
  - Inline VAST → витягує `<MediaFile>`, `<Duration>`, `<Tracking>` events, `<Impression>` URLs
  - Wrapper VAST → слідує за `<VASTAdTagURI>` рекурсивно (до 5 рівнів, 3с таймаут на кожен)
  - Збирає impression URLs та tracking events з кожного рівня wrapper'а
- Результат: `{ mediaUrl, duration, trackingEvents: Map, impressionUrls[], errorUrls[] }`

#### 4. AD_LOADING
- Передає `mediaUrl` в Shaka Player через `page.evaluate`:
  ```js
  window.__loadAd(mediaUrl)
  ```
- Shaka Player підтримує: MP4 (progressive), HLS (m3u8), DASH (mpd)
- Чекає `canplay` event (до 15с) і починає `play()`

#### 5. AD_PLAYING
- `ad-timeline.ts` генерує розклад tracking events:
  - **impression** — відразу (0ms)
  - **start** — через 200-600ms (імітація затримки play())
  - **firstQuartile** — 25% тривалості ± gaussian jitter
  - **midpoint** — 50%
  - **thirdQuartile** — 75%
  - **complete** — 100%
- **Drop-off модель**: 72% completion rate
  - 15% відвалюються до firstQuartile
  - 25% до midpoint
  - 60% до thirdQuartile
- `AdTimelineScheduler` планує `setTimeout` для кожного event'а
- `TrackingEngine` відправляє tracking pixels:
  - Impression → `impressionUrls[]`
  - Quartiles → URLs з `trackingEvents Map`
  - **Idempotent**: кожен event відправляється рівно один раз (за ключем `sessionId:event`)
  - Послідовно з мікрозатримками 20-80ms між URLs

#### 6. CONTENT_PLAYING
- Після завершення реклами переключається на контент:
  ```js
  window.__loadContent(contentUrl)
  ```
- Грає контент 5 секунд

#### 7. STOPPING → STOPPED
- Shaka Player `destroy()`, очищення ресурсів
- BrowserContext закривається
- Worker повідомляє Master про завершення

---

## Device Profiles (емуляція пристроїв)

### Підтримувані платформи

| OS | Vendor | Приклади моделей | UA |
|----|--------|------------------|----|
| AndroidTV | Sony, Nvidia, Xiaomi, TCL, Hisense | BRAVIA XR-55A95K, SHIELD Pro | Chrome/131 Linux Android |
| Tizen | Samsung | UN55TU8000, QN65Q80B, QN55S95B | SMART-TV LINUX Tizen |
| WebOS | LG | OLED55C3PUA, OLED65B3PSA | webOS Linux SmartTV Chrome/94 |

### Генерація профілів (`device-profiles.ts`)

- **OS version**: випадковий з реального діапазону (Android 12-14, Tizen 7-8, WebOS 23-24)
- **IP**: генерується в діапазонах US residential ISP (Comcast, AT&T, Verizon, Spectrum)
- **Geo**: 8 US регіонів з jitter'ом координат (NY, Chicago, Denver, LA, Phoenix, Miami, Houston, Atlanta)
- **Network**: 85% WiFi, 15% Ethernet (реалістично для CTV)
- **IFA**: UUID v4 (Identifier for Advertisers)
- **deviceId**: UUID v4

---

## Network Interceptor

Класифікація всіх мережевих запитів Playwright:

| Тип | Патерни |
|-----|---------|
| `rtb` | POST + `/bid`, `/openrtb`, `/auction` |
| `vast` | `/vast`, `.xml`, `vast=`, `adtag` |
| `media` | `.mp4`, `.m3u8`, `.ts`, `.webm`, `.mpd`, `.m4s` |
| `tracking` | `impression`, `track`, `pixel`, `beacon`, `event`, `quartile`, `complete` |
| `content` | все інше |

Логує: URL, method, status, duration, classification, direction.

---

## Prometheus Metrics

| Метрика | Тип | Опис |
|---------|-----|------|
| `sessions_running` | Gauge | Активні сесії |
| `rtb_requests_total` | Counter | Всього RTB запитів |
| `rtb_errors_total` | Counter | RTB помилки |
| `vast_requests_total` | Counter | VAST запити |
| `vast_errors_total` | Counter | VAST помилки |
| `tracking_events_total{event_type}` | Counter | Tracking events по типах |
| `session_duration_seconds` | Histogram | Тривалість сесій |

---

## Конфігурація сесії (JSON для POST /api/sessions)

```json
{
  "device": {
    "os": "AndroidTV",
    "osv": "13",
    "vendor": "Sony",
    "model": "BRAVIA XR-55A95K",
    "screenWidth": 1920,
    "screenHeight": 1080,
    "deviceId": "uuid",
    "ifa": "uuid",
    "ip": "73.45.123.89",
    "networkType": "WiFi",
    "language": "en",
    "userAgent": "Mozilla/5.0 (Linux; Android 13; BRAVIA XR-55A95K) ...",
    "timezone": "America/New_York",
    "geo": { "lat": 40.71, "lon": -74.01 }
  },
  "rtbEndpoint": "https://your-dsp-endpoint.com/bid",
  "contentUrl": "https://example.com/content-video.mp4",
  "appBundle": "com.pluto.tv",
  "appName": "Pluto TV",
  "appStoreUrl": "https://play.google.com/store/apps/details?id=com.pluto.tv",
  "appVersion": "2.4.1",
  "publisherId": "pub-123",
  "publisherName": "Pluto Inc"
}
```

Всі поля валідуються через Zod-схему.

---

## Player (public/player.html)

- **Shaka Player 4.7.11** — завантажується з CDN
- Два `<video>` елементи: `#ad-video` (z-index 10) та `#content-video` (z-index 1)
- API через `window.__*` функції:
  - `__initShaka()` — ініціалізація
  - `__loadAd(url)` — завантажити та грати рекламне відео
  - `__loadContent(url)` — завантажити та грати контент
  - `__getAdCurrentTime()` / `__getAdDuration()` — поточна позиція
  - `__stopAll()` — зупинити все
  - `__playerReady` — прапор готовності
  - `__adCompleted` — прапор завершення реклами

---

## Файлова структура

```
src/
├── index.ts                       — точка входу (startMaster)
├── master/
│   ├── server.ts                  — Fastify API (8 endpoints)
│   ├── scheduler.ts               — розподіл сесій по воркерах
│   ├── worker-manager.ts          — fork/restart/IPC воркерів
│   └── metrics.ts                 — Prometheus метрики
├── worker/
│   ├── worker.ts                  — головний цикл воркера (createSession/stopSession)
│   ├── session.ts                 — SessionStateMachine (state transitions)
│   ├── browser-pool.ts            — Playwright Browser/Context management
│   └── network-interceptor.ts     — класифікація мережевих запитів
├── engines/
│   ├── rtb-adapter.ts             — OpenRTB 2.6 bid request builder + sender
│   ├── vast-resolver.ts           — VAST XML parser + wrapper resolution
│   ├── ad-timeline.ts             — генерація розкладу quartile events
│   └── tracking-engine.ts         — idempotent tracking pixel firing
├── emulation/
│   ├── device-profiles.ts         — TV device generation (Sony, Samsung, LG, etc.)
│   └── network-profiles.ts        — 3G/4G/WiFi throughput presets
└── shared/
    ├── types.ts                   — TypeScript інтерфейси
    ├── schemas.ts                 — Zod валідація
    ├── constants.ts               — ліміти і таймаути
    └── logger.ts                  — Pino logger
```

---

## Технологічний стек

- Node.js 20 LTS, TypeScript strict
- Fastify 5.7 — API server
- Playwright ~1.49 — headless Chromium
- Shaka Player 4.7 — video (MP4/HLS/DASH)
- Zod 4.3 — validation
- Pino 10.3 — structured logging
- prom-client 15.1 — Prometheus metrics
- Docker (mcr.microsoft.com/playwright base)

---

## Зміни для роботи з реальним DSP (2026-03-05)

### Що було додано/виправлено

| Зміна | Файл | Навіщо |
|-------|------|--------|
| `bidfloor` + `bidfloorcur` в imp | rtb-adapter.ts, types.ts, schemas.ts | DSP не бідить без floor price. Default: $2.0 CPM |
| `source.fd` + `source.tid` | rtb-adapter.ts, types.ts | DSP потребують transaction ID для дедуплікації |
| `regs.coppa` + `regs.ext.gdpr` + `regs.ext.us_privacy` | rtb-adapter.ts, types.ts | Compliance signals — без них деякі DSP не бідять |
| `maxduration: 30` (фіксований) | rtb-adapter.ts | Було рандомне 30/60/90/120 — нереалістично для pre-roll |
| `imp.id` — hex8 замість `"1"` | rtb-adapter.ts | Унікальний ID для кожного impression |
| VAST validation в `extractVastFromBidResponse` | rtb-adapter.ts | Детектить якщо DSP повернув banner HTML замість VAST |
| `duration` fallback 15s | vast-resolver.ts | Якщо VAST не має `<Duration>`, використовує 15с |
| `mediaUrl` validation | vast-resolver.ts | Кидає помилку якщо VAST не містить `<MediaFile>` |
| `bidfloor` в SessionConfig | types.ts, schemas.ts | Можна конфігурувати floor per session |
| `DEFAULT_BIDFLOOR_VIDEO = 2.0` | constants.ts | Дефолтний floor для відео |
| `seat`, `nurl`, `adomain`, `crid` в RtbBidResponse | types.ts | Розширений тип для повного логування відповіді DSP |

### Конфігурація bidfloor

`bidfloor` можна передати в конфізі сесії (опціонально):

```json
{
  "device": { ... },
  "rtbEndpoint": "https://your-dsp.com/bid",
  "bidfloor": 1.5,
  ...
}
```

Якщо не передано — використовується `DEFAULT_BIDFLOOR_VIDEO` ($2.0).

### Захист від non-VAST відповідей

`extractVastFromBidResponse` тепер:
1. Перевіряє що `bid.adm` починається з `<` (XML)
2. Перевіряє наявність `<VAST` тегу
3. Якщо DSP повернув banner HTML — логує warning з preview перших 200 символів
4. Повертає `null` замість crash'у парсера
