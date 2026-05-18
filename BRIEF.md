# Brief: nexus-bot

> Bot de automatización para iniciar y finalizar jornadas laborales automáticamente en la plataforma interna Nexus (Global Talent Connections).

---

## 0. Cómo leer este documento

Este brief es la fuente única de verdad del proyecto. Está pensado para Claude Code: cada decisión ya fue tomada en una sesión de planificación previa. No hay nada que adivinar. Si algo no queda claro, **preguntar antes de codear**.

Convenciones:
- Las palabras en `código` son nombres exactos (variables de entorno, archivos, comandos, selectores).
- Donde diga "debe", "tiene que", "obligatorio" → no negociable.
- Donde diga "sugerido", "preferentemente" → hay margen de criterio.

---

## 1. Contexto del proyecto

### 1.1. Problema a resolver

El usuario (Renzo Payero) trabaja para Global Talent Connections, una empresa española. Tiene una plataforma interna llamada **Nexus** (alojada en Vercel) donde, de lunes a viernes, debe:

- A las **07:00 hora Argentina (UTC-3)**: hacer click en "Iniciar Jornada"
- A las **15:00 hora Argentina (UTC-3)**: hacer click en "Finalizar Jornada"

Es una acción manual repetitiva. Si se olvida o llega tarde, hay consecuencias laborales. La plataforma **no expone una API pública**, solo UI web.

### 1.2. Solución

Un bot que automatiza ambas acciones de forma confiable, con notificaciones de éxito/fallo y capacidad de recuperación ante errores transitorios.

### 1.3. Restricciones críticas

- **No hay entorno de prueba**: cada click es producción real. Si el bot inicia la jornada, se inicia de verdad.
- **El bot debe ser idempotente**: si la jornada ya está iniciada/finalizada, no debe romper nada al detectarlo.
- **Plataforma no oficial para automatización**: el bot tiene que ser conservador (timing humano, sin requests agresivos).

### 1.4. URLs de la plataforma

- Login: `https://global-talent-platform-v2-zeta.vercel.app/login`
- Flow (donde están los botones): `https://global-talent-platform-v2-zeta.vercel.app/flow`

### 1.5. Comportamiento observado de la UI

Página `/flow` contiene una sección **"Jornada Laboral"** con:

- Estado textual: muestra "Jornada finalizada", el contador (formato `HH:MM`) o el tiempo objetivo (ej. `15:00`).
- Un botón principal grande que dice:
  - `▶ Iniciar Jornada` cuando la jornada NO empezó
  - `Finalizar Jornada` cuando la jornada está en curso (a confirmar visualmente)
- Un botón secundario `⚠ Reportar Incidencia` (no usar)
- Texto de confirmación al final: "Ya finalizaste tu jornada de hoy. Buen trabajo." cuando ya terminó

Estos textos/selectores son los anclas para detectar el estado actual. Pueden ajustarse si Claude Code encuentra selectores más estables al inspeccionar la página real.

---

## 2. Stack y decisiones técnicas (todas cerradas)

| Item | Decisión | Razón |
|---|---|---|
| Lenguaje | Node.js 20 LTS | Familiar al usuario, ecosystem maduro para Playwright |
| Browser automation | **Playwright** | Mejor soporte para SPAs (Next.js/Vercel), API moderna |
| Modo del browser | Headless Chromium | Suficiente, menor consumo |
| Scheduling | `node-cron` | Simple, dentro del mismo proceso, mejor logging |
| Logging | `pino` con rotación diaria | Estructurado, performante, fácil de parsear |
| Email | `nodemailer` con SMTP de Gmail | App password ya disponible |
| Telegram | Llamadas HTTP directas a Telegram Bot API con `fetch` o `axios` | No necesitamos features complejas, evitamos dep extra |
| Containerización | Docker + docker-compose | El usuario ya lo usa en su VPS |
| Imagen base | `mcr.microsoft.com/playwright:v1.49.0-noble` | Trae Chromium y todas las deps del sistema |
| Persistencia de sesión | `storageState.json` montado como volumen | Evita re-login en cada ejecución |
| Notificaciones | **Telegram (primario) + email (respaldo)** | Telegram es rápido y confiable, email para auditoría |

---

## 3. Variables de entorno (`.env.example`)

Generar un `.env.example` con TODAS las siguientes variables. El archivo `.env` real (con valores) va en `.gitignore`.

```env
# === Nexus credentials ===
NEXUS_EMAIL=rpayero@globaltalentconnections.es
NEXUS_PASSWORD=__SET_IN_ENV__
NEXUS_LOGIN_URL=https://global-talent-platform-v2-zeta.vercel.app/login
NEXUS_FLOW_URL=https://global-talent-platform-v2-zeta.vercel.app/flow

# === Telegram ===
# Crear bot con @BotFather, obtener token. Chat ID con @userinfobot.
TELEGRAM_BOT_TOKEN=__SET_IN_ENV__
TELEGRAM_CHAT_ID=6885509518

# === Email (Gmail con App Password) ===
# Generar app password en: https://myaccount.google.com/apppasswords
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=__SET_IN_ENV__
SMTP_PASS=__SET_IN_ENV__
SMTP_FROM="Nexus Bot <__SET_IN_ENV__>"
SMTP_TO=__SET_IN_ENV__

# === Bot behavior ===
# true: el bot NO clickea botones reales ni manda notificaciones de producción (solo loguea)
# false: comportamiento real, modo producción
DRY_RUN=true

# Timezone (no cambiar)
TZ=America/Argentina/Buenos_Aires

# Logging level: trace | debug | info | warn | error
LOG_LEVEL=info

# Jitter máximo en segundos antes de ejecutar acción (0-90 sugerido)
# Reduce huella de bot. 0 desactiva.
MAX_JITTER_SECONDS=90

# === Schedule (cron syntax, en TZ definida arriba) ===
# Si querés cambiar el horario de la jornada, modificá acá. Default: 7am inicio, 15:00 fin.
CRON_START="0 7 * * 1-5"
CRON_END="0 15 * * 1-5"
CRON_HEARTBEAT="10 15 * * 1-5"
```

---

## 4. Arquitectura y estructura de archivos

```
nexus-bot/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── .env.example
├── .env                       # gitignored
├── .gitignore
├── README.md                  # generado por Claude Code, basado en este brief
├── src/
│   ├── index.js               # entrypoint: levanta cron scheduler
│   ├── config.js              # carga .env, valida, exporta config
│   ├── logger.js              # pino con rotación diaria
│   ├── browser.js             # gestión de Playwright + sesión persistente
│   ├── jornada.js             # lógica core: detectState, attemptAction, startJornada, endJornada
│   ├── notifier.js            # sendTelegram, sendEmail, notify, notifyError
│   ├── utils.js               # sleep, jitter, formatters
│   └── cli/                   # comandos manuales
│       ├── bootstrap.js       # primer login y guardado de storageState
│       ├── status.js          # detecta estado y reporta (no clickea)
│       ├── start.js           # ejecuta startJornada (respeta DRY_RUN)
│       ├── end.js             # ejecuta endJornada (respeta DRY_RUN)
│       └── test-notify.js     # envía mensajes de prueba a Telegram y email
└── data/                      # volumen Docker, gitignored
    ├── session/
    │   └── storageState.json  # cookies + localStorage
    ├── logs/
    │   ├── app-YYYY-MM-DD.log
    │   └── ...
    └── screenshots/
        └── YYYY-MM-DD_HH-mm-ss_<action>_<reason>.png
```

---

## 5. Comportamiento esperado por módulo

### 5.1. `src/config.js`

- Carga `.env` con `dotenv`.
- Valida que todas las variables obligatorias estén presentes. Si falta alguna, **lanza error con mensaje claro y termina el proceso** (no arrancar el bot con config inválida).
- Exporta un objeto `config` con todos los valores tipados correctamente (`DRY_RUN` como boolean, `MAX_JITTER_SECONDS` como number, etc.).
- Exporta también un objeto `paths` con las rutas calculadas: `paths.session`, `paths.logs`, `paths.screenshots`.

### 5.2. `src/logger.js`

- Pino con dos transports:
  - stdout (pretty en desarrollo, JSON en producción)
  - Archivo en `data/logs/app-YYYY-MM-DD.log` con rotación diaria.
- Retención: borrar logs de más de 30 días al arrancar.
- Nivel configurable por `LOG_LEVEL`.

### 5.3. `src/browser.js`

**Responsabilidades**:

- Mantener una instancia singleton de `BrowserContext` con `storageState` cargado.
- Exponer:
  - `getPage()`: retorna una page lista para usar (carga storageState si existe).
  - `refreshSession()`: hace login programático con credenciales del `.env` y guarda nuevo `storageState`.
  - `closeBrowser()`: cleanup al finalizar.

**Login flow** (`refreshSession`):

1. Navegar a `NEXUS_LOGIN_URL`.
2. Esperar campo de email (`input[type="email"]` o `input[name="email"]`).
3. Tipear `NEXUS_EMAIL` con `page.fill()` (no `type` para evitar timing variable).
4. Tipear `NEXUS_PASSWORD` en el campo de password.
5. Click en botón "Ingresar".
6. Esperar redirect a `/flow` o `/dashboard` (timeout 15s).
7. Si llega → guardar `storageState` en `data/session/storageState.json`.
8. Si no llega → throw error específico (`LOGIN_FAILED`).

**Detección de sesión viva**: cuando se cargue una page, si la URL final tras `goto` contiene `/login` o `/auth`, considerar sesión expirada y disparar `refreshSession`.

**Configuración del browser**:

- User-agent realista (no el default de headless).
- Viewport: `1920x1080`.
- Locale: `es-AR`.
- Timezone: `America/Argentina/Buenos_Aires`.
- `bypassCSP: false` (no bypassear nada).

### 5.4. `src/jornada.js`

**Constantes**:

```js
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000]; // 30s, 2min, 5min
```

**Selectores** (probar varios fallbacks, registrar cuál matcheó):

```js
const SELECTORS = {
  startBtn: [
    'button:has-text("Iniciar Jornada")',
    'button:has-text("Iniciar jornada")',
    '[data-testid="start-jornada"]', // si existiera
  ],
  endBtn: [
    'button:has-text("Finalizar Jornada")',
    'button:has-text("Finalizar jornada")',
    'button:has-text("Terminar Jornada")',
  ],
  finishedText: [
    'text=/ya finalizaste tu jornada/i',
    'text=/jornada finalizada/i',
  ],
  inProgressIndicator: [
    // un contador corriendo, ej "01:23" formato HH:MM
    'text=/^\\d{2}:\\d{2}$/',
  ],
};
```

Claude Code: al inspeccionar la página real, ajustar selectores si encontrás identificadores más estables (data-* attributes, IDs, classes).

**Función `detectState(page)`**:

1. `page.goto(NEXUS_FLOW_URL, { waitUntil: 'networkidle', timeout: 30_000 })`.
2. Si URL final incluye `/login` o `/auth` → throw `SESSION_EXPIRED`.
3. Esperar 1-2s para que renderice (SPAs a veces lentas).
4. Buscar selectores en este orden:
   - Si `finishedText` visible → return `'finished'`.
   - Si `endBtn` visible → return `'in_progress'`.
   - Si `startBtn` visible → return `'not_started'`.
   - Si ninguno → return `'unknown'` y loguear el HTML del bloque "Jornada Laboral" para debug.

**Función `attemptAction({ action, fromState, toState, label })`**:

Pseudocódigo:

```
for attempt in [0..3]:
  try:
    page = await getPage()
    state = await detectState(page)
    
    # Idempotencia: ya está completado
    if state == toState:
      log info "ya estaba en estado destino"
      notify(`✅ ${label}: ya estaba completada (idempotente)`)
      return
    
    # Estado inesperado: no clickear nada, alertar
    if state != fromState:
      shot = await page.screenshot({ fullPage: true })
      notifyError(`⚠️ ${label}: estado inesperado "${state}". No ejecuto acción.`, shot)
      return
    
    # Jitter humano
    jitter = random(0, MAX_JITTER_SECONDS) seconds
    log info `Esperando ${jitter}s antes de clickear (jitter)`
    await sleep(jitter * 1000)
    
    # DRY RUN
    if DRY_RUN:
      log info `[DRY_RUN] habría clickeado ${action} en página ${page.url()}`
      notify(`🧪 [DRY_RUN] ${label}: habría clickeado, no se hizo nada`)
      return
    
    # Click real
    selector = (action == 'start') ? startBtn : endBtn
    await page.locator(selector).first().click()
    await page.waitForTimeout(3000) # esperar UI update
    
    # Verificar que cambió de estado
    newState = await detectState(page)
    if newState == toState:
      log info `${action} OK`
      notify(`✅ ${label} correctamente - ${ahora en AR}`)
      return
    
    throw new Error(`POST_CLICK_STATE_MISMATCH: esperaba ${toState}, obtuve ${newState}`)
  
  except error:
    log error con error.message
    
    if error.message == 'SESSION_EXPIRED':
      notify(`🔑 Sesión expirada, re-logueando...`)
      await refreshSession()
      attempt -= 1  # este intento no consume retry
      continue
    
    # Errores no recuperables (selector no existe en página cargada, etc.)
    retryable = /timeout|net::|ERR_|navigation|networkidle/i.test(error.message)
    if not retryable and attempt == 0:
      shot = await page.screenshot({ fullPage: true })
      notifyError(`❌ ${label}: error no recuperable - ${error.message}`, shot)
      return
    
    # Retry con delay
    if attempt < RETRY_DELAYS_MS.length:
      log info `Reintentando en ${RETRY_DELAYS_MS[attempt] / 1000}s`
      await sleep(RETRY_DELAYS_MS[attempt])
    else:
      shot = await page.screenshot({ fullPage: true })
      notifyError(`❌ ${label} falló tras 4 intentos - ${error.message}`, shot)
```

**Exports**:

```js
export const startJornada = () => attemptAction({
  action: 'start',
  fromState: 'not_started',
  toState: 'in_progress',
  label: 'Iniciar jornada',
});

export const endJornada = () => attemptAction({
  action: 'end',
  fromState: 'in_progress',
  toState: 'finished',
  label: 'Finalizar jornada',
});

export const getStatus = async () => {
  const page = await getPage();
  return detectState(page);
};
```

### 5.5. `src/notifier.js`

**Funciones**:

- `sendTelegram(text, photoBuffer = null)`: POST a `https://api.telegram.org/bot<TOKEN>/sendMessage` o `/sendPhoto` si hay imagen. `parse_mode: 'HTML'`. Retorna `{ ok: true | false, error?: string }`. Nunca throw — los errores de notificación no deben tumbar el bot.

- `sendEmail(subject, htmlBody, attachments = [])`: nodemailer con SMTP de Gmail. Retorna igual estructura.

- `notify(text)`: éxito o info normal. Manda a Telegram. **No manda email** (evitar spam — email solo para fallos).

- `notifyError(text, screenshotBuffer = null)`: fallo. Manda a Telegram con foto si hay, **y también email** con el screenshot adjunto. Subject del email: `[NEXUS-BOT] ❌ ${text.slice(0, 60)}`.

**Comportamiento si DRY_RUN está activado**: las notificaciones de éxito (`notify`) deben prefijar el texto con `🧪 [DRY_RUN]`. Las de error (`notifyError`) se mandan igual (queremos ver errores incluso en dry-run).

**Formato de mensajes Telegram** (HTML soportado):

```
✅ <b>Jornada iniciada</b>
🕒 Sun May 17 2026, 07:00:23 (ART)
⏱️ Tomó 12s
```

```
❌ <b>Iniciar Jornada falló</b>
Tras 4 intentos.
<i>Error: POST_CLICK_STATE_MISMATCH: esperaba in_progress, obtuve unknown</i>

📸 Screenshot adjunto.
```

### 5.6. `src/index.js`

Entrypoint del contenedor. Comportamiento:

1. Cargar y validar config.
2. Inicializar logger.
3. Verificar que existe `storageState.json` — si no existe, loguear warning y mandar mensaje a Telegram: "⚠️ No hay sesión guardada. Ejecutá `npm run login:bootstrap` antes del próximo cron."
4. Borrar logs viejos (>30 días).
5. Registrar handlers de `SIGTERM`/`SIGINT` para cerrar el browser y flushear logs.
6. Mandar mensaje a Telegram: `🤖 Nexus Bot iniciado. DRY_RUN=${value}. Próxima jornada: ${proxima}. Próximo fin: ${proximo}.`
7. Registrar tres `cron.schedule`:
   - `CRON_START` → `startJornada` con timezone AR
   - `CRON_END` → `endJornada` con timezone AR
   - `CRON_HEARTBEAT` → mandar mensaje "💚 Heartbeat OK - YYYY-MM-DD HH:mm:ss" a Telegram (NO email)
8. Mantener proceso vivo.

### 5.7. CLI commands (`src/cli/*.js`)

Cada uno ejecutable vía `package.json` scripts:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "login:bootstrap": "node src/cli/bootstrap.js",
    "jornada:status": "node src/cli/status.js",
    "jornada:start": "node src/cli/start.js",
    "jornada:end": "node src/cli/end.js",
    "notify:test": "node src/cli/test-notify.js"
  }
}
```

**`bootstrap.js`**: ejecuta `refreshSession()` y termina. Output: "Login OK, sesión guardada en data/session/storageState.json" o error.

**`status.js`**: ejecuta `getStatus()` y printea el estado. **NO clickea nada, nunca**. Útil para validar conectividad y selectores. Termina con exit code 0 si encontró estado válido, 1 si `unknown`.

**`start.js` / `end.js`**: ejecutan `startJornada()` / `endJornada()` una vez y terminan. Respetan `DRY_RUN`. Acepta flag opcional `--force` que ignora idempotencia (raro de usar, pero útil si la detección de estado falla).

**`test-notify.js`**: manda un mensaje "Mensaje de prueba desde nexus-bot — ${timestamp}" a Telegram y email. Reporta el resultado por stdout.

---

## 6. Dockerfile

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Instalar deps primero para cachear esta layer
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código
COPY src ./src

# Crear directorios de datos
RUN mkdir -p /app/data/session /app/data/logs /app/data/screenshots

# El usuario default de la imagen Playwright es `pwuser` pero corre como root.
# Para no complicarla con permisos del volumen, dejamos como root (es un contenedor aislado).

CMD ["node", "src/index.js"]
```

Notas:
- No usar `npm install` en build, solo `npm ci`.
- No copiar `.env` al contenedor — se inyecta via `env_file` en docker-compose.
- No copiar `data/` al contenedor — se monta como volumen.

---

## 7. docker-compose.yml

```yaml
services:
  nexus-bot:
    build: .
    container_name: nexus-bot
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    mem_limit: 900m
    memswap_limit: 1g
    cpus: 1.0
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(0)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Notas:
- `mem_limit: 900m` para no comerse toda la RAM del VPS (2GB total compartidos con otras apps del usuario).
- El healthcheck es básico (verifica que node responde). Se puede mejorar luego con un check más profundo.

---

## 8. .gitignore

```
node_modules/
.env
data/
*.log
.DS_Store
```

---

## 9. README.md

Claude Code debe generar un README claro con:

- Descripción de qué hace el proyecto.
- Setup local (clone, npm install, copiar `.env.example` a `.env`, llenar valores).
- Cómo crear bot de Telegram y obtener token + chat_id.
- Cómo generar Gmail app password.
- Comandos disponibles.
- Cómo deployar en VPS.
- Cómo monitorear logs (`docker compose logs -f`).
- Cómo pausar (`docker compose stop`).
- Cómo cambiar de DRY_RUN a producción.
- Troubleshooting (sesión expirada, selectores cambiados, etc.).

---

## 10. Definition of Done (checklist)

Claude Code: dar por terminado el proyecto solo cuando TODO esto pase:

### 10.1. Build & estructura
- [ ] `package.json` con todas las deps y scripts definidos.
- [ ] `npm ci` corre sin errores.
- [ ] `docker compose build` corre sin errores.
- [ ] Estructura de archivos exactamente como en sección 4.

### 10.2. Config & arranque
- [ ] `.env.example` está completo.
- [ ] Sin `.env`, el bot falla con mensaje claro (no arranca con config inválida).
- [ ] Con `.env` válido y `DRY_RUN=true`, `npm start` arranca y loguea "Nexus Bot iniciado".

### 10.3. CLI
- [ ] `npm run notify:test` → llega mensaje a Telegram y a email.
- [ ] `npm run login:bootstrap` → genera `data/session/storageState.json`.
- [ ] `npm run jornada:status` → reporta uno de `not_started | in_progress | finished | unknown`, sin clickear.
- [ ] `npm run jornada:start` con `DRY_RUN=true` → loguea "habría clickeado" y manda mensaje `🧪 [DRY_RUN] ...` a Telegram. **No clickea**.
- [ ] `npm run jornada:end` con `DRY_RUN=true` → idem.

### 10.4. Behavior
- [ ] Detección de estado funciona en los 3 estados visibles de la página (`not_started`, `in_progress`, `finished`).
- [ ] Si la sesión expira, el bot detecta y re-loguea automáticamente.
- [ ] Si un click falla con error recuperable, reintenta con backoff 30s/2min/5min.
- [ ] Si todos los reintentos fallan, manda `notifyError` con screenshot.
- [ ] Si el estado actual ya es el destino, no clickea y manda mensaje idempotente.
- [ ] Jitter aleatorio se aplica antes de cada click real (no en dry-run).

### 10.5. Docker
- [ ] `docker compose up -d` levanta el contenedor.
- [ ] El contenedor se reinicia solo si el proceso muere.
- [ ] El contenedor consume menos de 900MB.
- [ ] El volumen `./data` se persiste entre rebuilds.
- [ ] Logs se ven con `docker compose logs -f`.

### 10.6. Notificaciones
- [ ] Telegram recibe mensajes de éxito.
- [ ] Telegram recibe mensajes de error con screenshot adjunto.
- [ ] Email recibe SOLO los errores (no los éxitos).
- [ ] Telegram recibe heartbeat diario a las 15:10 ART (días hábiles).
- [ ] Telegram recibe mensaje de arranque "🤖 Nexus Bot iniciado..." cuando arranca el contenedor.

---

## 11. Plan de testing (en orden, antes del deploy)

Todo lo siguiente con `DRY_RUN=true`:

1. `npm ci` y `npm run notify:test`. Validar que llegan ambos canales.
2. `npm run login:bootstrap`. Validar que el `storageState.json` se crea. Si falla, debuggear el login flow.
3. `npm run jornada:status`. **Debe reportar `finished`** (porque al momento de planificar, la jornada de hoy del usuario ya estaba terminada — ver screenshot original). Si reporta otra cosa, debuggear los selectores antes de seguir.
4. `npm run jornada:start`. Debe loguear "[DRY_RUN] habría clickeado" y mandar mensaje correspondiente. NO debe clickear nada de verdad.
5. `npm run jornada:end`. Idem.
6. `docker compose build` y `docker compose up -d`. Validar log de arranque y mensaje de Telegram de "🤖 Bot iniciado".
7. `docker compose exec nexus-bot npm run jornada:status`. Validar que también funciona desde dentro del contenedor.

Solo cuando los pasos 1-7 estén OK, pasar a producción:

8. Editar `.env`: `DRY_RUN=false`.
9. `docker compose restart nexus-bot`.
10. Confirmar mensaje de Telegram "🤖 Bot iniciado. DRY_RUN=false. Próxima jornada: ..."
11. Esperar a 7am del día siguiente.

---

## 12. Plan de deploy en VPS (Hostinger)

El VPS ya tiene Docker y docker-compose instalados. Tiene 2GB de RAM compartidos con otras apps del usuario.

1. En el VPS: `cd /home/<user>/projects` (o donde el usuario tenga sus proyectos).
2. `git clone <repo-url> nexus-bot && cd nexus-bot`.
3. `cp .env.example .env` y editar `.env` con valores reales.
4. `docker compose build`.
5. `docker compose run --rm nexus-bot npm run notify:test` → validar canales.
6. `docker compose run --rm nexus-bot npm run login:bootstrap` → genera storageState.
7. `docker compose run --rm nexus-bot npm run jornada:status` → validar conectividad.
8. Con `DRY_RUN=true` aún, `docker compose up -d` y validar logs por unos minutos.
9. Cuando todo OK, editar `.env` → `DRY_RUN=false`, `docker compose restart`.

---

## 13. Reglas de oro para Claude Code

1. **No alucinar selectores**. Si no estás seguro de un selector, abrir la página real (o pedirle al usuario que comparta el HTML del bloque "Jornada Laboral") antes de codear los selectores.
2. **No clickear nunca en desarrollo sin DRY_RUN=true**. El usuario va a estar testeando contra producción real.
3. **Idempotencia es sagrada**. Antes de cualquier acción destructiva, detectar el estado actual y validar que tenga sentido continuar.
4. **Las notificaciones nunca deben tumbar el bot**. Si Telegram o SMTP fallan, loguear y seguir. El bot no puede crashear porque Telegram esté caído.
5. **Logs estructurados**, no `console.log` sueltos. Usar `logger.info({ context }, 'mensaje')`.
6. **Screenshots en cada fallo**. Son evidencia para debuggear.
7. **No agregar features que no están en este brief** sin preguntar. Mantener simple.

---

## 14. Información del usuario para contexto

- Renzo Payero, systems engineer, ya usa Docker en su flow diario.
- Habla español rioplatense informal (voseo). Las notificaciones de Telegram pueden ser en ese tono si suma simpatía, pero priorizar claridad técnica.
- Su email Nexus: `rpayero@globaltalentconnections.es`.
- Chat ID de Telegram: `6885509518` (chat privado con el bot).
- VPS: Hostinger 2GB compartido con otras apps web.

---

## 15. Lo que NO está en alcance (para no hacer)

- Detección de feriados argentinos. El usuario apaga el bot manualmente.
- Comandos interactivos de Telegram (`/pause`, `/status`, etc.). El usuario pausa con `docker compose stop`.
- Dashboard web o métricas. Solo logs + notificaciones.
- Multi-usuario. Es bot personal para una sola cuenta.
- Auto-actualizaciones, OTA, etc.

---

Fin del brief. Si hay algo ambiguo, preguntar antes de codear.
