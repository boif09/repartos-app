# Repartos — Diseño del MVP

Clon personal y pequeño de Splitwise para dejar de pagar la suscripción. Uso principal desde el móvil.

Casos de uso:

1. **Pareja**: gastos que Xavi y Judit pagan con dinero personal, aparte de la previsión de `prevision-gastos-web`.
2. **Viajes**: igual, pero con pagos en moneda extranjera.
3. **Amigos**: fines de semana y planes en grupo donde pagan varios.

---

## 1. Decisiones tomadas

| Tema | Decisión |
|---|---|
| Ubicación | App nueva e independiente. Mismo servidor que TripFlow, subdominio `repartos.jusboif.es` |
| Stack | Node 24 sin dependencias de npm: `node:http`, `node:sqlite`, `node:test`, `node:crypto`. Frontend vanilla JS como PWA |
| Persistencia | SQLite (WAL). Una petición por cambio, nunca "guardar todo el estado" |
| Dinero | Siempre enteros en unidades menores (céntimos). Nunca `float` para guardar |
| Personas | Globales, solo nombre. Se vinculan a grupos |
| Saldos | Se calculan al leer a partir de gastos y liquidaciones. No se guardan |
| Simplificar deudas | Dentro de cada grupo. Óptimo exacto hasta 15 personas con saldo, greedy por encima |
| Divisas | Moneda base por grupo. Cada gasto guarda el importe original, la moneda y un tipo de cambio fijo |
| Acceso | Authelia (el login común de jusboif.es) para Xavi y Judit, y enlaces de solo lectura por grupo para amigos |
| Offline | Fase 1: consulta sin conexión (caché). Para guardar hace falta red |
| Pagadores | Uno por gasto en el MVP. El modelo permite ampliarlo más adelante |

Fuera del MVP, para después: importar el CSV de Splitwise, cola de escritura offline, categorías, varios pagadores, gastos recurrentes, gráficos, adjuntar foto del ticket y notificaciones.

---

## 2. Estructura del proyecto

```text
repartos-app/
├── server.js                    Arranque (PORT, HOST, señales)
├── src/
│   ├── app.js                   Router HTTP, estáticos, BASE_PATH, auth
│   ├── auth.js                  Login, cookie firmada, rate limit
│   ├── database.js              Conexión, PRAGMAs, migraciones (user_version)
│   ├── repository.js            Consultas y transacciones
│   └── fx.js                    Tipos de cambio (Frankfurter + caché)
├── shared/                      Dominio puro, usado por servidor Y navegador
│   ├── money.js                 Exponentes de divisa, formateo, reparto de céntimos
│   ├── splits.js                Calcular owed_cents por modo de reparto
│   ├── balances.js              Saldos netos y deudas por pares
│   └── settle.js                Minimizar pagos (óptimo + greedy)
├── public/
│   ├── index.html
│   ├── app.js                   SPA con rutas por hash (#/grupos/12)
│   ├── styles.css               Diseño para móvil primero
│   ├── manifest.webmanifest
│   ├── sw.js                    Service worker (caché del shell y lecturas)
│   └── icons/
├── test/
│   ├── money.test.js  splits.test.js  balances.test.js  settle.test.js
│   └── api.test.js              API completa contra SQLite :memory:
├── data/                        repartos.db (no se sube a git)
├── ecosystem.config.cjs
├── nginx-repartos.conf.example
└── deploy-repartos.sh
```

`shared/` se sirve estático en `/repartos/shared/`. El formulario de gasto usa el mismo código de reparto que el servidor para la vista previa en directo, y el servidor siempre recalcula y valida.

---

## 3. Modelo de datos (SQLite)

```sql
CREATE TABLE people (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX ux_people_name ON people(name COLLATE NOCASE) WHERE archived_at IS NULL;

CREATE TABLE expense_groups (   -- "groups" es palabra clave en SQLite ≥ 3.28
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  emoji              TEXT,
  base_currency      TEXT NOT NULL DEFAULT 'EUR',     -- ISO 4217
  simplify_debts     INTEGER NOT NULL DEFAULT 1,
  default_split      TEXT,                            -- JSON {"personId": weight}, p. ej. 60/40 en Pareja
  share_token        TEXT UNIQUE,                     -- NULL = no compartido
  archived_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_members (
  group_id   INTEGER NOT NULL REFERENCES expense_groups(id),
  person_id  INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (group_id, person_id)
);

CREATE TABLE expenses (
  id                TEXT PRIMARY KEY,                 -- UUID generado en el cliente (idempotencia)
  group_id          INTEGER NOT NULL REFERENCES expense_groups(id),
  description       TEXT NOT NULL,
  spent_on          TEXT NOT NULL,                    -- YYYY-MM-DD
  payer_id          INTEGER NOT NULL REFERENCES people(id),
  original_minor    INTEGER NOT NULL CHECK (original_minor > 0),
  currency          TEXT NOT NULL,
  fx_rate           TEXT,                             -- decimal en texto; NULL si currency = base
  fx_source         TEXT,                             -- 'ecb' | 'manual' | 'card'
  base_cents        INTEGER NOT NULL CHECK (base_cents > 0),
  split_mode        TEXT NOT NULL CHECK (split_mode IN ('equal','exact','shares')),
  notes             TEXT,
  version           INTEGER NOT NULL DEFAULT 1,       -- control de concurrencia optimista
  deleted_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ix_expenses_group ON expenses(group_id, deleted_at, spent_on);

CREATE TABLE expense_shares (
  expense_id   TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  person_id    INTEGER NOT NULL REFERENCES people(id),
  input_value  INTEGER NOT NULL,   -- equal: 1 | shares: peso | exact: importe en unidades menores ORIGINALES
  owed_cents   INTEGER NOT NULL,   -- resultado en céntimos de la moneda base
  PRIMARY KEY (expense_id, person_id)
);

CREATE TABLE settlements (
  id           TEXT PRIMARY KEY,                      -- UUID del cliente
  group_id     INTEGER NOT NULL REFERENCES expense_groups(id),
  from_id      INTEGER NOT NULL REFERENCES people(id),
  to_id        INTEGER NOT NULL REFERENCES people(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_on      TEXT NOT NULL,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (from_id <> to_id)
);

CREATE TABLE fx_cache (
  base TEXT, quote TEXT, day TEXT, rate TEXT,
  PRIMARY KEY (base, quote, day)
);
```

Invariantes que el servidor valida en cada escritura, dentro de una transacción:

- `SUM(expense_shares.owed_cents) = expenses.base_cents`.
- El pagador y todos los participantes son miembros del grupo. El pagador puede no participar (paga por otros).
- En el modo `exact`, `SUM(input_value) = original_minor` (los importes se introducen en la moneda original).

---

## 4. Reglas de dominio

### 4.1 Dinero y divisas (`shared/money.js`)

- El exponente de cada divisa sale de `Intl.NumberFormat(..., {currency}).resolvedOptions().maximumFractionDigits`: EUR/USD 2, JPY 0, etc.
- **Conversión**: `base_cents = round(original_minor × fx_rate × 10^(expBase − expOrig))`, con un único redondeo.
- **El tipo de cambio se fija al guardar** y no se recalcula nunca después.
- El usuario puede **sobrescribir el importe en EUR** con lo que cobró la tarjeta. Entonces `fx_source = 'card'` y el tipo efectivo se muestra como informativo.
- El tipo se sugiere desde la API Frankfurter (BCE, gratis y sin clave), con el día como caché en `fx_cache`. El BCE no cubre todas las divisas (p. ej. VND o ARS): si no hay dato o falla la red, se pide a mano.

### 4.2 Repartos (`shared/splits.js`)

Una sola función `computeShares(baseCents, mode, inputs, originalMinor)` devuelve `owed_cents` por persona:

| Modo | Entrada en el formulario | Cálculo |
|---|---|---|
| `equal` | Interruptores por persona (todos marcados por defecto) | Pesos = 1 para los marcados |
| `shares` | Peso por persona (60/40, 2/1/1…). Valor inicial = `expense_groups.default_split` | Proporcional a los pesos |
| `exact` | Importe por persona en la moneda original | Proporcional a esos importes (en EUR sale idéntico) |

Una persona con peso o importe 0 no participa (no se crea su fila en `expense_shares`), y tiene que haber al menos un participante con peso mayor que 0.

Los tres modos acaban en el mismo algoritmo, **reparto proporcional con el método del mayor resto**:

1. `ideal_i = baseCents × peso_i / Σpesos`. Cada uno recibe `floor(ideal_i)`.
2. Los céntimos sobrantes van a quien tenga mayor parte fraccionaria. Los empates se resuelven en un orden determinista derivado del id del gasto, para que el céntimo extra no recaiga siempre en la misma persona.

Ejemplo: 10 € entre 3 → 3,34 / 3,33 / 3,33. Los céntimos siempre cuadran.

Ayudas del formulario en el modo `exact`:

- Barra en directo con el estado: "Asignado 87,60 € de 100,00 € · faltan 12,40 €". No deja guardar hasta que cuadra.
- Botón **"Repartir lo que falta a partes iguales"** entre los marcados, para la propina, el pan o el vino compartido.

### 4.3 Saldos (`shared/balances.js`)

Para cada persona del grupo:

```
saldo = Σ base_cents de lo que pagó
      − Σ owed_cents de lo que le corresponde
      + Σ liquidaciones que ha pagado
      − Σ liquidaciones que ha recibido
```

`saldo > 0` significa que le deben y `saldo < 0` que debe. Los saldos del grupo suman exactamente 0, y eso se comprueba en los tests.

**Deudas por pares**, que se usan cuando `simplify_debts = 0`: por cada gasto, cada participante debe su `owed_cents` al pagador, y cada liquidación lo compensa. Se calcula el neto de cada par.

### 4.4 Minimizar pagos (`shared/settle.js`)

Entrada: saldos netos distintos de cero. Salida: una lista de `{from, to, amount_cents}`.

- **Óptimo exacto** (si hay ≤ 15 personas con saldo distinto de cero). Programación dinámica sobre subconjuntos: `pagos = k − (máximo nº de subgrupos disjuntos que suman 0)`. Es O(2^k · k) y tarda menos de 10 ms con k = 16 (medido). Después se reconstruyen los subgrupos y dentro de cada uno se liquida con greedy.
- **Greedy** (si k > 15): el mayor deudor paga al mayor acreedor y se repite. Como mucho k − 1 pagos.
- Un test fija el contraejemplo en el que el greedy falla: saldos +80, +70, +40, −60, −60, −70. El greedy da 5 pagos y el óptimo 4.
- Solo dentro de cada grupo. Nunca se mezclan grupos.

En la pantalla de saldos, cada pago sugerido lleva el botón **"Marcar como pagado"**, que crea una liquidación ya rellenada y editable (por si el pago es parcial).

### 4.5 Borrados y personas

- **Gastos y liquidaciones**: borrado suave (`deleted_at`), con un aviso de "Deshacer" de unos 5 s y una papelera por grupo.
- **Quitar a alguien de un grupo**: solo si no aparece en ningún gasto ni liquidación activos.
- **Personas**: se pueden renombrar y archivar, pero nunca borrar si tienen historial.
- **Grupos**: se pueden archivar cuando están liquidados (todos los saldos a 0). Aparecen en "Archivados" y son de solo lectura: lo único que admiten es desarchivarse.

### 4.6 Concurrencia

- Cada cambio es una transacción SQLite.
- **Crear es idempotente**: el UUID lo genera el móvil. Si la red falla y se reintenta, no se duplica el gasto, algo importante con conexiones inestables.
- **Editar y borrar requieren `version`**. Si otro dispositivo lo cambió antes, se devuelve 409 y la app avisa "Este gasto ha cambiado, recárgalo". Nunca gana el último en silencio.

---

## 5. Acceso y seguridad

Hoy ni `prevision-gastos-web` ni TripFlow tienen control de acceso. Esta app no puede ir así: contiene nombres y dinero, y la URL estará en internet.

- **Para Xavi y Judit**: el mismo **Authelia** que protege el resto de `jusboif.es`. nginx valida la sesión con `auth_request` y pasa la cabecera `Remote-User`. La app la acepta solo desde `127.0.0.1` y para los usuarios de `APP_USERS`. Esta app no guarda contraseñas ni cookies propias.
- **Para amigos**: `share_token` aleatorio de 128 bits por grupo. Abre `/repartos/s/<token>` en **solo lectura** (gastos, saldos y pagos sugeridos) y se puede regenerar o revocar desde los ajustes del grupo. Esta ruta y la API compartida son lo único accesible sin sesión: van en una `location` de nginx sin Authelia y con `Remote-User` vaciado.
- **"Quién soy"**: sale del usuario de Authelia (`people.auth_user`), así la app sabe sin preguntar si eres Xavi o Judit.
- **PWA con Authelia**: el manifest se pide con `crossorigin="use-credentials"`, y cuando la sesión caduca la app recarga para pasar por `auth.jusboif.es`.
- **Cabeceras y validación**: `Content-Security-Policy` estricta (sin JS inline), todo el HTML escapado (sin `innerHTML` con datos sin escapar) y tamaño máximo del cuerpo de las peticiones.

---

## 6. API

Todo bajo `/api`, en JSON. Todas las rutas requieren usuario de Authelia salvo `health` y `shared`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/session` | Usuario actual |
| GET / POST | `/people` | Listar o crear personas |
| PATCH | `/people/:id` | Renombrar o archivar |
| GET | `/people/:id/summary` | Saldo de la persona en cada grupo y totales por moneda |
| GET / POST | `/groups` | Listar (con mi saldo) o crear |
| GET / PATCH | `/groups/:id` | Detalle y ajustes |
| POST / DELETE | `/groups/:id/members[/:personId]` | Añadir o quitar miembros |
| GET | `/groups/:id/expenses?before=…` | Gastos paginados por fecha |
| POST | `/groups/:id/expenses` | Crear (con UUID del cliente) |
| PUT / DELETE | `/expenses/:id` | Editar o borrar (suave); ambos exigen `version` |
| POST | `/expenses/:id/restore` | Deshacer un borrado |
| GET | `/groups/:id/balances` | Saldos, deudas por pares y pagos sugeridos |
| POST | `/groups/:id/settlements` | Registrar un pago |
| DELETE | `/settlements/:id` | Borrar un pago (suave) |
| POST / DELETE | `/groups/:id/share` | Generar o revocar el enlace compartido |
| GET | `/fx?from=JPY&to=EUR&date=2026-11-02` | Tipo de cambio sugerido |
| GET | `/shared/:token` | Vista de solo lectura para amigos |

---

## 7. Pantallas (móvil primero)

Navegación inferior con **Grupos · Personas · Ajustes**.

1. **Grupos (inicio)**: tarjetas con emoji, título y *mi* saldo ("Te deben 42,10 €" en verde, "Debes 15,00 €" en rojo) y un botón "+ Grupo". Los archivados van plegados al final.
2. **Grupo**: cabecera con el título y mi saldo, y dos pestañas:
   - **Gastos**: lista por fecha. Cada fila muestra descripción, quién pagó, importe (con el original si es otra moneda) y "te toca X €". Las liquidaciones aparecen intercaladas con otro estilo.
   - **Saldos**: saldo de cada miembro y "Pagos sugeridos" (A → B, importe, botón **Marcar como pagado**).
   - Un botón flotante **+** para añadir un gasto.
3. **Nuevo o editar gasto**, en una sola pantalla:
   - Descripción e importe grande con teclado decimal y selector de moneda (por defecto la del grupo).
   - Si la moneda no es la base: tipo de cambio sugerido, "≈ 23,40 €" y un campo opcional "Me cobraron (€)".
   - Pagado por (chips) y fecha (hoy por defecto).
   - **Para quién**: chips de miembros, todos activos por defecto, con atajo "Todos / Ninguno".
   - **Cómo** (selector de tres opciones): Iguales | Importes | Partes. Según el modo, cada persona muestra su parte calculada o un campo para escribirla.
   - Barra de validación fija y botón Guardar.
4. **Ajustes del grupo**: título, emoji, moneda base, miembros (añadir una persona existente con autocompletado, o crearla escribiendo el nombre), reparto por defecto, simplificar deudas (sí/no), enlace compartido (copiar, regenerar, revocar) y archivar.
5. **Personas** y **detalle de persona**: saldo en cada grupo con enlace al grupo, y el total por moneda.
6. **Vista compartida** (amigos): igual que el grupo, pero sin botones de edición.

Detalles de PWA: `manifest.webmanifest` con `display: standalone`, iconos de 192 y 512 px y `theme_color`. El service worker cachea el shell (cache-first) y las lecturas de la API (red primero con caché de respaldo). Sin conexión, la app muestra un aviso y desactiva Guardar.

---

## 8. Despliegue

Igual que TripFlow:

- **pm2**: proceso `repartos`, `HOST=127.0.0.1`, `PORT=3016` (libre en el servidor), `BASE_PATH=/`, `APP_USERS=xavi,judit`, `DB_PATH=/var/lib/repartos/repartos.db` (fuera del directorio del código), `NODE_ENV=production`.
- **nginx**: sitio propio `repartos.jusboif.es` con certificado de certbot y los snippets de Authelia, igual que TripFlow.
- **Authelia**: regla `one_factor` para `repartos.jusboif.es` limitada a `user:xavi` y `user:judit`.
- **Backup**: `sqlite3 repartos.db ".backup …"` (o `VACUUM INTO`) diario por cron, con rotación de 30 días. No hace falta parar la app.
- `deploy-repartos.sh` toma como base el de TripFlow (tests y check antes de reiniciar pm2).

---

## 9. Tests (`node --test`)

- **money**: exponentes (EUR, JPY, KWD), conversión con un único redondeo, sobrescritura "card".
- **splits**: la suma siempre coincide, los empates son deterministas, `exact` sin cuadrar da error, `exact` en moneda extranjera, subconjuntos y pagador que no participa.
- **balances**: suma 0 con miles de gastos aleatorios (prueba de propiedades), y las liquidaciones compensan.
- **settle**: con muchos casos aleatorios, el óptimo hace ≤ pagos que el greedy y ambos dejan todos los saldos a 0; además, el contraejemplo 5 frente a 4 y el caso de 2 personas.
- **api**: login y sesión, rutas protegidas devuelven 401, crear el mismo UUID dos veces no duplica, editar con `version` antigua da 409, quitar un miembro con historial da error, el token compartido solo lee y deja de funcionar al revocarlo.

---

## 10. Plan de construcción

| Fase | Contenido | Hecho cuando… |
|---|---|---|
| **F0 Esqueleto** | server, router, BASE_PATH, auth con Authelia, migraciones, tests, pm2 y nginx de ejemplo | Sesión simulada en local y `npm test` en verde |
| **F1 Núcleo** | Personas, grupos, miembros, gastos `equal` en EUR, saldos, pagos sugeridos, liquidaciones | Grupo "Pareja" usable de principio a fin desde el móvil |
| **F2 Repartos** | Subconjuntos, `exact` con "repartir lo que falta", `shares` y reparto por defecto del grupo | Caso restaurante y caso alcohol resueltos |
| **F3 Divisas** | Moneda por gasto, Frankfurter con caché, tipo manual, "me cobraron" | Viaje en JPY con saldos en EUR correctos |
| **F4 Móvil y compartir** | PWA instalable, caché offline de lectura, enlace de amigos, detalle de persona | Instalada en ambos móviles y enlace enviado a un amigo |
| **F5 Despliegue** | DNS, certificado, regla de Authelia, `deploy-repartos.sh`, backups, publicación en `repartos.jusboif.es` | En producción con backup diario verificado |
| **F6 Sin conexión** | Apariencia clara/oscura, cola de gastos y pagos sin conexión | Gasto apuntado en modo avión y sincronizado al volver |
| **F7 Colaboración** | Varios pagadores, autoría, actividad, avisos push, resumen, categorías, búsqueda | Ver ampliaciones (§11) |
| *Descartado* | Importar CSV de Splitwise | — |

Antes de cancelar Splitwise: exportar el CSV de cada grupo (Splitwise lo permite por grupo) para tener el histórico. El importador puede venir en una fase posterior, y como mínimo basta un gasto de "saldo inicial" por grupo.

---

## 11. Ampliaciones (F7)

### 11.1 Varios pagadores

- Tabla `expense_payers(expense_id, person_id, input_value, paid_cents)`. La migración 3 la rellena con el pagador único de cada gasto; `expenses.payer_id` se mantiene como pagador principal (el que más pagó) por compatibilidad.
- `computePayers` (`shared/splits.js`) valida que lo pagado sume el total, sin repetir personas. En otra moneda se reparte el total convertido con el mismo resto mayor que las partes (semilla `id:pagadores`).
- Saldos: cada pagador suma lo que pagó. Deudas por pareja: la parte de cada persona se reparte entre los pagadores en proporción a lo pagado.
- Los gastos antiguos y los de la cola offline sin `payers` se tratan como de un solo pagador (`payersOf`).

### 11.2 Autoría y actividad

- `expenses.created_by`, `expenses.updated_by` y `settlements.created_by` guardan la persona de Authelia que hizo el cambio.
- Tabla `activity`: cada cambio (gastos, pagos, miembros, grupo) se apunta dentro de la misma transacción. Solo se ve la actividad de los grupos de los que eres miembro.
- `activity_seen` guarda el último evento visto por persona; las novedades excluyen lo que hizo uno mismo. La campana de inicio muestra un punto si hay novedades.

### 11.3 Avisos push

- Sin dependencias: cifrado `aes128gcm` (RFC 8291, verificado con el vector del RFC) y VAPID ES256 (RFC 8292). La clave VAPID se genera la primera vez y se guarda en `app_settings`.
- Los avisos se envían después del COMMIT y nunca bloquean la respuesta. Se avisa a los demás miembros con usuario de gastos nuevos, editados o borrados y de pagos. Un 404/410 del servicio borra la suscripción.
- En iPhone solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4+).

### 11.4 Resumen, categorías y búsqueda

- Pestaña "Resumen" en cada grupo: total gastado, número de gastos, fechas, media diaria, lo que pagó cada uno frente a su parte y gasto por categoría.
- `shared/categories.js`: categorías fijas y sugerencia automática por palabras de la descripción, que el usuario puede cambiar.
- Búsqueda en la lista de gastos (a partir de 4 gastos), sin tildes ni mayúsculas.

---

## 12. Ampliaciones (F8)

### 12.1 Color de grupo

- `expense_groups.color` (migración 4) con una clave de `shared/palette.js`; sin elegir, un color fijo según el id. Los 8 tonos dan contraste AA con texto blanco.
- Las pantallas de un grupo (gastos, pago, ajustes) usan su color como acento (`.app.grouped`, variable `--g`).

### 12.2 Gastos recurrentes

- Migración 5: tabla `recurring_expenses` (id = el del primer gasto, frecuencia semanal/mensual/anual, `anchor_on`, `next_on`, `template`, `paused_reason`) y `expenses.recurring_id`.
- Se crean al guardar un gasto con "Repetir" (solo en la moneda del grupo). El servidor genera las repeticiones pendientes al arrancar, cada hora y al crear la serie (si la fecha era antigua, se rellenan las que faltaban).
- Cada repetición tiene un id determinista (sha256 de la serie y la fecha): una pasada cortada a medias no duplica nada.
- Mensual y anual conservan el día de la primera vez (31 → 28 feb → 31 mar). "Hoy" se calcula en `APP_TIMEZONE`.
- Si una repetición no se puede crear (alguien salió del grupo, grupo archivado), la serie se pausa y el motivo se ve en Ajustes.
- Editar una repetición con "aplicar también a las próximas" actualiza la plantilla. "Dejar de repetir" borra la serie; los gastos ya creados se quedan.

### 12.3 Viajes

- `expense_groups.is_trip`. En el Resumen de un viaje: barras de gasto por día (por semana si pasa de 45 días) y lo que le costó el viaje a cada uno, con su media diaria.
