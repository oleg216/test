# CTV Emulator Platform — Документацiя

## Що це таке?

Це платформа, яка **iмiтує Smart TV пристрої** (Connected TV) у headless-режимi — тобто без реального телевiзора. Вона програє повний цикл вiдео-реклами так, як це вiдбувається на справжньому телевiзорi.

## Навiщо це потрiбно?

Уяви, що ти SSP/DSP платформа i хочеш перевiрити:

- Чи правильно вiдправляються **bid-запити** (OpenRTB) до рекламних бiрж?
- Чи коректно парситься **VAST XML** (формат рекламних креативiв)?
- Чи вiдправляються **tracking pixels** (impression, start, quartiles, complete)?
- Чи витримає iнфраструктура **навантаження** (50+ паралельних сесiй)?
- Чи правильно вiдпрацьовує **anti-fraud** логiка?

Замiсть купувати 200 телевiзорiв — запускаєш цю платформу i вона iмiтує їх.

## Як працює одна сесiя?

Кожна сесiя — це **iзольований вiртуальний телевiзор**:

```
1. Створюється Chromium браузер з профiлем пристрою
   (наприклад: Samsung Tizen TV, UA, IP, роздiльна здатнiсть 1920x1080)

2. Вiдправляється OpenRTB 2.6 bid-запит на рекламну бiржу
   ("У мене є глядач на Samsung TV, є що показати?")

3. Бiржа вiдповiдає VAST XML з посиланням на вiдео-рекламу

4. Платформа парсить VAST (в тому числi wrapper chains до 5 рiвнiв)

5. Завантажується та програється рекламне вiдео через Shaka Player

6. Пiд час програвання файряться tracking events:
   - impression (0с)  — реклама показана
   - start (0с)       — почалось вiдтворення
   - firstQuartile    — 25% переглянуто
   - midpoint         — 50% переглянуто
   - thirdQuartile    — 75% переглянуто
   - complete         — 100% переглянуто

7. Пiсля реклами програється контент (основне вiдео)

8. Сесiя закривається
```

## Архiтектура

```
Master Process (HTTP API на порту 3100)
│
├── REST API          — керування сесiями, health check, метрики
├── SessionScheduler  — розподiляє сесiї по воркерам (хто менше завантажений)
├── WorkerManager     — запускає/перезапускає worker-процеси
└── MetricsRegistry   — Prometheus метрики
│
└── Worker Processes (зараз 3 штуки, кожен = окремий Chromium)
    ├── BrowserPool         — headless Chromium через Playwright
    ├── SessionStateMachine — контролює стани (CREATED → ... → STOPPED)
    ├── NetworkInterceptor  — логує весь трафiк (rtb/vast/media/tracking)
    └── Engines:
        ├── RtbAdapter      — формує OpenRTB bid-запити
        ├── VastResolver    — парсить VAST XML, слiдує wrapper chains
        ├── AdTimeline      — розраховує таймiнги quartile events
        └── TrackingEngine  — вiдправляє tracking pixels (рiвно 1 раз)
```

## API Ендпоiнти

Базовий URL: `http://localhost:3100`

| Метод | Шлях | Опис |
|-------|------|------|
| `GET` | `/health` | Перевiрка стану сервiсу |
| `GET` | `/metrics` | Prometheus метрики |
| `GET` | `/api/workers` | Стан воркерiв |
| `GET` | `/api/sessions` | Список всiх сесiй |
| `GET` | `/api/sessions/:id` | Деталi конкретної сесiї |
| `POST` | `/api/sessions` | Створити сесiю |
| `POST` | `/api/sessions/batch` | Створити до 50 сесiй одразу |
| `DELETE` | `/api/sessions/:id` | Зупинити сесiю |

## Як тестувати

### 1. Перевiрка що сервiс живий

```bash
curl http://localhost:3100/health
# {"status":"ok","uptime":...}
```

### 2. Перевiрка воркерiв

```bash
curl http://localhost:3100/api/workers
# Повинно показати 3 воркери зi статусом "running"
```

### 3. Створення тестової сесiї

Для створення сесiї потрiбно передати конфiг вiртуального пристрою та RTB endpoint.

**Мiнiмальний приклад (з фейковим RTB endpoint):**

```bash
curl -X POST http://localhost:3100/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "device": {
      "os": "AndroidTV",
      "vendor": "Google",
      "model": "Chromecast",
      "screenWidth": 1920,
      "screenHeight": 1080,
      "deviceId": "test-device-001",
      "ifa": "00000000-0000-0000-0000-000000000001",
      "ip": "203.0.113.1",
      "networkType": "WiFi",
      "userAgent": "Mozilla/5.0 (Linux; Android 12; Chromecast) AppleWebKit/537.36",
      "timezone": "Europe/Kyiv"
    },
    "rtbEndpoint": "https://httpbin.org/post",
    "contentUrl": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    "appBundle": "com.test.app",
    "appName": "TestApp",
    "appStoreUrl": "https://play.google.com/store/apps/details?id=com.test.app"
  }'
```

> **Примiтка:** `httpbin.org/post` — це тестовий сервер, який просто повертає
> те, що йому надiслали. Справжня бiржа поверне VAST XML з рекламою.
> Тому сесiя створиться, але впаде на етапi RTB (бо httpbin не повертає
> валiдну bid-response). Це нормально для тесту — можна побачити як сесiя
> проходить через стани.

### 4. Перевiрка стану сесiї

```bash
# Список всiх сесiй
curl http://localhost:3100/api/sessions

# Деталi конкретної сесiї (пiдставити id з вiдповiдi)
curl http://localhost:3100/api/sessions/<SESSION_ID>
```

### 5. Зупинка сесiї

```bash
curl -X DELETE http://localhost:3100/api/sessions/<SESSION_ID>
```

### 6. Prometheus метрики

```bash
curl http://localhost:3100/metrics
```

Метрики:
- `sessions_running` — скiльки сесiй зараз активнi
- `tracking_events_total` — кiлькiсть вiдправлених tracking events
- `rtb_requests_total` / `rtb_errors_total` — RTB статистика
- `vast_requests_total` / `vast_errors_total` — VAST статистика

### 7. Запуск unit-тестiв (всерединi контейнера)

```bash
docker exec ctv-emulator npm test
```

### 8. Запуск iнтеграцiйних тестiв (проти живого сервера)

```bash
cd /var/oleg216-test
TEST_URL=http://localhost:3100 npx vitest run tests/integration/
```

## Конфiгурацiя (поточна, пiд цей сервер)

| Параметр | Значення | Опис |
|----------|----------|------|
| `PORT` | 3000 (внутрiшнiй) → 3100 (зовнiшнiй) | HTTP порт |
| `MAX_WORKERS` | 3 | Кiлькiсть Chromium-процесiв |
| `MAX_SESSIONS` | 30 | Максимум паралельних сесiй |
| `SESSIONS_PER_WORKER` | 10 | Лiмiт сесiй на воркер |
| `RTB_TIMEOUT_MS` | 2000 | Таймаут bid-запиту |
| `VAST_TIMEOUT_MS` | 3000 | Таймаут VAST resolve |
| `MEDIA_TIMEOUT_MS` | 5000 | Таймаут завантаження вiдео |
| `RAM лiмiт` | 2GB | Docker memory limit |

## Формат тiла запиту для створення сесiї

```jsonc
{
  "device": {
    "os": "AndroidTV" | "Tizen" | "WebOS",    // обов'язково
    "vendor": "string",                        // виробник (Google, Samsung, LG)
    "model": "string",                         // модель пристрою
    "screenWidth": 1920,                       // роздiльна здатнiсть
    "screenHeight": 1080,
    "deviceId": "string",                      // унiкальний ID пристрою
    "ifa": "uuid",                             // рекламний iдентифiкатор
    "ip": "string",                            // IP адреса пристрою
    "carrier": "string",                       // опцiонально, оператор
    "networkType": "WiFi" | "4G" | "3G",       // тип мережi
    "userAgent": "string",                     // User-Agent
    "timezone": "string",                      // напр. "Europe/Kyiv"
    "geo": { "lat": 50.45, "lon": 30.52 }     // опцiонально
  },
  "rtbEndpoint": "https://...",                // URL бiржi для bid-запитiв
  "contentUrl": "https://...m3u8",             // URL основного вiдео (HLS)
  "appBundle": "com.example.app",              // bundle ID додатку
  "appName": "MyApp",                          // назва додатку
  "appStoreUrl": "https://...",                // посилання на стор
  "networkEmulation": {                        // опцiонально — iмiтацiя мережi
    "type": "4G",
    "downloadThroughput": 4000000,
    "uploadThroughput": 3000000,
    "latency": 20,
    "packetLoss": 0.001
  }
}
```

## Стани сесiї (lifecycle)

```
CREATED → INITIALIZING → RTB_REQUESTING → VAST_RESOLVING → AD_LOADING → AD_PLAYING → CONTENT_PLAYING → STOPPING → STOPPED
```

Можливi помилки на будь-якому етапi:
- `ERROR_VAST` — не вдалося розпарсити VAST
- `ERROR_MEDIA` — не завантажилось вiдео
- `ERROR_NETWORK` — мережева помилка
- `ERROR_TIMEOUT` — таймаут на якомусь етапi

## Docker команди

```bash
# Запустити
docker compose up -d

# Зупинити
docker compose down

# Логи
docker logs ctv-emulator -f

# Перезапустити
docker compose restart

# Перебiлдити пiсля змiн
docker compose up -d --build
```
