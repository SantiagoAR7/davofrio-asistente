# DAVOFRIO — Asistente Técnico IA

Sistema interno de diagnóstico de averías para técnicos de refrigeración y climatización.

## Requisitos
- Node.js 22.12+
- Supabase con la tabla `rag_chunks`
- Microsoft 365 con acceso a los manuales de OneDrive
- Poppler (`pdftotext` y `pdftoppm`) y Tesseract para PDFs escaneados

---

## Instalación

```bash
cd davofrio
npm install
```

---

## Configuración

### 1. API Key de OpenAI
Edita el archivo `.env`:
```
OPENAI_API_KEY=sk-proj-TU_KEY_AQUI
SESSION_SECRET=una-cadena-aleatoria-de-al-menos-24-caracteres
ADMIN_PASSWORD=una-contraseña-inicial-segura
PORT=3000
```

También se requieren `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` y
`ONEDRIVE_USER`.

### Preparar Supabase

```bash
# Ejecuta migrations/001_rag_atomic.sql una sola vez en el SQL Editor de Supabase.
```

La migración añade el reemplazo atómico de un manual y las estadísticas del
índice. No elimina los fragmentos existentes.

### Crear el administrador inicial

Cuando `data/db.json` todavía no contiene usuarios, el servidor crea el usuario
`admin` con el valor de `ADMIN_PASSWORD`. Después crea las cuentas del equipo
desde Administración → Técnicos. No existen contraseñas predeterminadas.

---

## Arrancar el servidor

```bash
npm start
```

Accede en: **http://localhost:3000**

Para uso en red local (que todos los técnicos puedan acceder):
```bash
# Busca tu IP local
ipconfig getifaddr en0   # Mac
# Los técnicos acceden en: http://TU-IP:3000
```

---

## Cómo funciona

1. **El técnico escribe el código** (ej: `E4`, `CH05`, `U4 Daikin`)
2. **La IA detecta la marca automáticamente** — si el código está en varias marcas, pregunta cuál
3. **El recuperador híbrido consulta Supabase**, filtra marca, código, modelo y familia del equipo
4. **El modelo responde una sola vez** usando los fragmentos recuperados y cita los manuales
5. **El administrador** ve en tiempo real el historial de cada técnico: qué consultó, cuándo, sobre qué marca

Si no hay evidencia suficiente o el código corresponde a varias familias de
equipos, el sistema pide el modelo exacto en lugar de inventar un diagnóstico.

---

## Estructura del proyecto

```
davofrio/
├── server/
│   ├── index.js          # Servidor Express principal
│   ├── onedrive.js       # Descarga de manuales desde Microsoft Graph
│   ├── chunker.js        # Fragmentos con límite estricto de tokens
│   ├── rag.js            # Recuperación y generación basada en evidencia
│   └── db.js             # Base de datos JSON simple
├── public/
│   └── index.html        # Frontend completo (login + chat + admin)
├── data/
│   ├── db.json           # Usuarios e historial (auto-generado)
│   └── rag_inventory_filtered.json # Inventario aprobado para indexar
├── migrations/           # Funciones SQL requeridas en Supabase
├── scripts/audit-rag.js  # Auditoría local y remota del índice
├── tests/                # Pruebas de API, frontend, chunking y RAG
├── .env                  # Variables de entorno
└── package.json
```

---

## Indexar y validar manuales

```bash
npm test
npm run audit:rag
npm run audit:rag:live
RAG_BATCH_LIMIT=25 npm run index:rag
```

El indexador guarda el avance en `data/supabase_index_state.json`. Prepara todos
los fragmentos y embeddings antes de reemplazar el manual en una transacción; si
la extracción o OpenAI fallan, conserva la versión anterior.

---

## Seguridad
- Las contraseñas se guardan con bcrypt (hash seguro)
- La API Key de OpenAI nunca sale del servidor
- Las sesiones expiran a las 8 horas
- Desactivar, eliminar o cambiar la contraseña/rol revoca las sesiones existentes
- Solo el admin puede ver el historial y gestionar usuarios
- Las respuestas HTML se filtran antes de mostrarse
