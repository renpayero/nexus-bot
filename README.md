# nexus-bot

Bot de automatización Node.js + Playwright que inicia y finaliza tu jornada laboral en la plataforma interna **Nexus** (Global Talent Connections), de lunes a viernes, con notificaciones por Telegram (primario) y email (errores). Pensado para correr en VPS dentro de Docker.

> Fuente de verdad de decisiones técnicas: [`BRIEF.md`](./BRIEF.md). Si algo discrepa con este README, el brief manda.

---

## Cómo funciona

- A las **07:00 hora Argentina (UTC-3)** clickea **Iniciar Jornada**.
- A las **15:00 ART** clickea **Finalizar Jornada**.
- A las **15:10 ART** manda un heartbeat por Telegram.
- Detecta estado antes de clickear → es **idempotente** (si ya está iniciada/finalizada, no rompe nada).
- Reintenta con backoff `30s → 2min → 5min` ante errores transitorios.
- Si la sesión expiró, re-loguea automáticamente (con tope de 2 intentos).
- Toma screenshot ante cada fallo y lo manda por Telegram + email.

---

## Setup local

### 1. Requisitos
- Node.js 20 LTS o superior
- Docker + docker-compose (para deploy)

### 2. Clonar e instalar
```bash
git clone <repo-url> nexus-bot
cd nexus-bot
npm ci
```

### 3. Configurar credenciales
```bash
cp .env.example .env
```

Editar `.env` y reemplazar todos los `__SET_IN_ENV__`:

#### a) Telegram
1. Hablar con [@BotFather](https://t.me/BotFather) en Telegram → `/newbot` → seguir pasos. Obtenés un **token**.
2. Hablar con [@userinfobot](https://t.me/userinfobot) → te responde tu **chat_id** numérico.
3. Hablar con tu bot recién creado al menos una vez (mandar `/start`) para que pueda enviarte mensajes.
4. Pegar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env`.

#### b) Gmail (App Password)
1. Activar verificación en dos pasos en tu cuenta Google.
2. Ir a [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) y crear una "App password" (nombre sugerido: `nexus-bot`).
3. Copiar la contraseña de 16 caracteres a `SMTP_PASS`.
4. `SMTP_USER`, `SMTP_FROM` y `SMTP_TO` apuntan a tu Gmail.

#### c) Nexus
- `NEXUS_EMAIL` ya viene seteado con `rpayero@globaltalentconnections.es`. Cambiar si corresponde.
- `NEXUS_PASSWORD`: tu contraseña real de Nexus.

#### d) DRY_RUN
- **Siempre arrancar con `DRY_RUN=true`**. El bot no clickea nada de verdad mientras esté activo. Solo cuando pasaste los gates de testing, lo bajás a `false`.

---

## Comandos disponibles

| Script | Qué hace |
|---|---|
| `npm start` | Arranca el scheduler (lo que corre el contenedor) |
| `npm run notify:test` | Manda un mensaje de prueba a Telegram + email |
| `npm run login:bootstrap` | Hace login en Nexus y guarda la sesión en `data/session/storageState.json` |
| `npm run jornada:status` | Detecta el estado actual de la jornada (no clickea) |
| `npm run jornada:start` | Ejecuta `startJornada` una vez (respeta `DRY_RUN`) |
| `npm run jornada:end` | Ejecuta `endJornada` una vez (respeta `DRY_RUN`) |

`jornada:start` y `jornada:end` aceptan flag `--force` que saltea el chequeo de idempotencia (raro de usar).

---

## Plan de testing (en orden)

Con `DRY_RUN=true`:

1. `npm ci` — sin errores
2. `npm run notify:test` — verificar que llegan Telegram y email
3. `npm run login:bootstrap` — verificar que se crea `data/session/storageState.json`
4. `npm run jornada:status` — debe reportar `not_started`, `in_progress` o `finished` (no `unknown`). Si reporta `unknown`, los selectores cambiaron — revisar logs (capturan el HTML del bloque "Jornada Laboral") y ajustar `src/jornada.js`.
5. `npm run jornada:start` — debe loguear `[DRY_RUN] habría clickeado` y mandar `🧪 [DRY_RUN]` por Telegram. **No clickea**.
6. `npm run jornada:end` — idem.
7. `docker compose build && docker compose up -d` — contenedor levanta, mensaje "🤖 Bot iniciado" llega a Telegram.

Solo cuando 1-7 pasen, pasar a producción:

8. Editar `.env`: `DRY_RUN=false`
9. `docker compose restart nexus-bot`
10. Confirmar mensaje Telegram "🤖 Bot iniciado. DRY_RUN=false. ..."
11. Esperar al primer cron real.

---

## Deploy en VPS

```bash
# En el VPS
cd ~/projects   # o donde tengas tus proyectos
git clone <repo-url> nexus-bot
cd nexus-bot
cp .env.example .env
nano .env       # llenar valores reales (DRY_RUN=true al principio)
mkdir -p data/session data/logs data/screenshots
docker compose build
docker compose run --rm nexus-bot npm run notify:test
docker compose run --rm nexus-bot npm run login:bootstrap
docker compose run --rm nexus-bot npm run jornada:status
docker compose up -d
# tras unos minutos en DRY_RUN, editar .env → DRY_RUN=false
docker compose restart nexus-bot
```

---

## Monitoreo y operación

```bash
# Ver logs en tiempo real
docker compose logs -f nexus-bot

# Ver logs persistidos
ls -lh data/logs/

# Pausar
docker compose stop nexus-bot

# Reanudar
docker compose start nexus-bot

# Reiniciar (tras cambios en .env)
docker compose restart nexus-bot

# Re-loguear manualmente si la sesión expira de forma persistente
docker compose run --rm nexus-bot npm run login:bootstrap
```

---

## Troubleshooting

**`jornada:status` reporta `unknown`**
- La UI cambió. El log tiene un snippet HTML del bloque "Jornada Laboral". Ajustar `SELECTORS` en `src/jornada.js`.

**Sesión expira seguido**
- Correr `npm run login:bootstrap` para regenerar `storageState.json`.
- Si pasa muy seguido, revisar política de cookies/sesión de Nexus.

**Telegram no llega**
- Validar `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
- Asegurarse de haber mandado al menos un mensaje al bot (`/start`).
- Probar con `npm run notify:test`.

**Email no llega**
- Validar que la App Password de Gmail esté bien (16 caracteres, sin espacios).
- Mirar en spam.
- Probar con `npm run notify:test`.

**El bot clickeó cuando no debía**
- Revisar `DRY_RUN` en `.env`. Si está en `true`, no debió clickear. Reportar el log.

**Feriados argentinos**
- El bot no detecta feriados. Pausarlo manualmente con `docker compose stop nexus-bot` la noche anterior.

---

## Cambiar de DRY_RUN a producción

1. Confirmar que pasaron los 7 pasos del plan de testing.
2. Editar `.env`: `DRY_RUN=false`.
3. `docker compose restart nexus-bot`.
4. Verificar mensaje Telegram: `🤖 Bot iniciado. DRY_RUN=false. ...`.
5. Esperar al próximo cron real (07:00 o 15:00 ART) y confirmar mensaje de éxito.

---

## Estructura

```
nexus-bot/
├── BRIEF.md                # fuente de verdad
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example            # plantilla; copiar a .env y llenar
├── .gitignore
├── README.md
├── src/
│   ├── index.js            # scheduler
│   ├── config.js           # validación de env
│   ├── logger.js           # pino + rotación diaria
│   ├── browser.js          # Playwright + storageState
│   ├── jornada.js          # detectState + attemptAction
│   ├── notifier.js         # Telegram + email
│   ├── utils.js            # sleep, jitter, escapeHtml, fechas AR
│   └── cli/
│       ├── bootstrap.js
│       ├── status.js
│       ├── start.js
│       ├── end.js
│       └── test-notify.js
└── data/                   # gitignored, montado como volumen
    ├── session/storageState.json
    ├── logs/app-YYYY-MM-DD.log
    └── screenshots/...
```
