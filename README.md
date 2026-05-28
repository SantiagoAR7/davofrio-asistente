# DAVOFRIO — Asistente Técnico IA

Sistema interno de diagnóstico de averías para técnicos de refrigeración y climatización.

## Requisitos
- Node.js 18+
- Cuenta Google con acceso a los manuales en Drive

---

## Instalación

```bash
cd davofrio
npm install
```

---

## Configuración en 3 pasos

### 1. API Key de OpenAI
Edita el archivo `.env`:
```
OPENAI_API_KEY=sk-proj-TU_KEY_AQUI
SESSION_SECRET=cambia-esto-por-algo-secreto
PORT=3000
```

### 2. Google Drive — Token de autenticación

Ejecuta este script para autenticarte con la cuenta de Drive donde están los manuales:

```bash
node scripts/auth-drive.js
```

Se abrirá el navegador para autenticar. El token se guarda en `data/drive_token.json`.

### 3. Crear usuarios técnicos
Al arrancar la primera vez se crea el usuario administrador:
- Usuario: `admin`
- Contraseña: `admin123`

Entra, ve a Administración → Técnicos → Nuevo técnico para crear los usuarios del equipo.

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
3. **Si selecciona una marca en el sidebar**, se cargan todos sus PDFs de Drive en memoria
4. **GPT-4o responde** con el diagnóstico exacto del manual: causas, pasos numerados, condiciones sí/no, tablas de valores
5. **El administrador** ve en tiempo real el historial de cada técnico: qué consultó, cuándo, sobre qué marca

---

## Estructura del proyecto

```
davofrio/
├── server/
│   ├── index.js          # Servidor Express principal
│   ├── drive.js          # Servicio Google Drive (carga PDFs)
│   └── db.js             # Base de datos JSON simple
├── public/
│   └── index.html        # Frontend completo (login + chat + admin)
├── data/
│   ├── db.json           # Usuarios e historial (auto-generado)
│   └── drive_token.json  # Token OAuth Drive (generado por auth-drive.js)
├── scripts/
│   └── auth-drive.js     # Script de autenticación Drive
├── .env                  # Variables de entorno
└── package.json
```

---

## Añadir nuevos manuales
Simplemente sube los PDFs a la carpeta correspondiente en Google Drive.
La próxima vez que un técnico seleccione esa marca, se cargarán automáticamente.

---

## Seguridad
- Las contraseñas se guardan con bcrypt (hash seguro)
- La API Key de OpenAI nunca sale del servidor
- Las sesiones expiran a las 8 horas
- Solo el admin puede ver el historial y gestionar usuarios
