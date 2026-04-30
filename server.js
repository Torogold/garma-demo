import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

if (!process.env.GROQ_API_KEY) {
  console.error('❌ Falta GROQ_API_KEY. El agente no funcionará.');
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD no definido. Usando valor por defecto inseguro.');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Rate limiting con limpieza periódica ──────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const now = Date.now();
  const timestamps = (rateLimits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_MAX) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento.' });
  }
  timestamps.push(now);
  rateLimits.set(ip, timestamps);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimits) {
    const fresh = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) rateLimits.delete(ip);
    else rateLimits.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

// ── Kill switch ───────────────────────────────────────────────────────────────
function checkActive(req, res, next) {
  if (process.env.ACTIVO === 'false') {
    return res.json({ respuesta: 'El servicio está temporalmente suspendido. Llámanos al 637 55 85 33.' });
  }
  next();
}

// ── Auth admin ────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'garma-admin-2026';
function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── Base de datos persistente ─────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = join(DATA_DIR, 'reservas.json');
const INSTRUCCIONES_PATH = join(DATA_DIR, 'instrucciones.json');

function loadReservas() {
  if (!existsSync(DB_PATH)) return [];
  try { return JSON.parse(readFileSync(DB_PATH, 'utf-8')); } catch { return []; }
}

function saveReservas(reservas) {
  const tmp = DB_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(reservas, null, 2));
  renameSync(tmp, DB_PATH);
}

function loadInstrucciones() {
  if (!existsSync(INSTRUCCIONES_PATH)) return [];
  try { return JSON.parse(readFileSync(INSTRUCCIONES_PATH, 'utf-8')); } catch { return []; }
}

function saveInstrucciones(instrucciones) {
  const tmp = INSTRUCCIONES_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(instrucciones, null, 2));
  renameSync(tmp, INSTRUCCIONES_PATH);
}

// ── Sesiones con TTL ──────────────────────────────────────────────────────────
const sesiones = new Map();
const SESSION_TTL = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sesiones) {
    if (now - s.ts > SESSION_TTL) sesiones.delete(id);
  }
}, 30 * 60 * 1000).unref();

function getHistorial(sessionId) {
  if (!sesiones.has(sessionId)) sesiones.set(sessionId, { historial: [], ts: Date.now() });
  const s = sesiones.get(sessionId);
  s.ts = Date.now();
  return s.historial;
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente virtual de Garma Automoción, empresa de automoción con 39 años de experiencia en Extremadura y Salamanca.

REGLA #1 — NUNCA INVENTES NADA. Si no estás 100% seguro de un dato (disponibilidad, precios no listados, modelos concretos disponibles), responde: "Para confirmar ese dato lo mejor es que llames al 637 55 85 33".

REGLA #2 — Habla en español natural y cercano. Tono profesional pero humano. Máximo 3-4 frases por respuesta.

REGLA #3 — NUNCA calcules ni sugieras qué día de la semana cae una fecha concreta. Si el cliente pregunta si un día concreto es laborable, dile que el horario es de lunes a viernes y que confirme llamando si tiene dudas.

## SOBRE GARMA
- Empresa familiar con ~39 años de experiencia en automoción
- Servicios: alquiler de vehículos, venta de coches, taller mecánico, renting
- Sede central: Polígono Industrial, Parcela 33 — Montehermoso (Cáceres)

## SEDES Y TELÉFONOS
- Ventas general: 637 55 85 33
- Plasencia: 678 486 095 · Carretera de Cáceres 12, 10600 Plasencia
- Coria: 680 851 332 · C/ del Guijo s/n (AES Autobuses, local 31)
- Béjar: 656 805 110 · C/ de la Estación s/n (AES Autobuses, local 2)
- Navalmoral de la Mata: 679 646 953 · Ctra. de Jarandilla s/n (AES Autobuses, local 3)
- Montehermoso: 927 430 235 · Polígono Industrial, Parcela 33

## HORARIOS
- Plasencia: Lunes a Viernes 8:00 – 18:00
- Resto de sedes: Lunes a Viernes 8:00 – 16:00
- Fines de semana: cerrado

## ALQUILER DE VEHÍCULOS (precios por día)
**Turismos:**
- Citroën C3 / Peugeot 208 → 51 €/día
- Combi 5 plazas → 54 €/día
- Opel Mokka / Renault Captur / MG ZS / Seat Arona / Ford Puma / Opel Astra / Peugeot 2008 → 64 €/día

**Furgonetas:**
- Furgoneta 7m³ → 64 €/día
- Furgoneta 12m³ → 74 €/día

**Combis:**
- Combi 9 plazas (Nissan NV300) → 95 €/día

## OTROS SERVICIOS
- **Venta de ocasión:** vehículos certificados Spoticar con garantía hasta 24 meses y financiación
- **Taller multimarca:** mantenimiento, revisiones, cambio de aceite, frenos, reparaciones con piezas originales. Email taller: talleresgarma@talleresgarma.es
- **Renting:** contratos flexibles de 24 a 60 meses, deducible para empresas y autónomos

## GESTIÓN DE RESERVAS DE ALQUILER
Cuando el cliente quiera reservar un vehículo, recoge estos datos uno a uno:
1. Tipo de vehículo o necesidad (turismo, furgoneta, combi...)
2. Sede donde recoge el vehículo
3. Fecha de inicio — SIEMPRE pide DÍA, MES y AÑO completos en formato DD/MM/YYYY
4. Fecha de fin — SIEMPRE pide DÍA, MES y AÑO completos en formato DD/MM/YYYY
5. Nombre completo
6. Teléfono de contacto

NUNCA aceptes fechas relativas ("mañana", "la semana que viene", "el lunes"). Si el cliente las dice, pregunta la fecha exacta: "¿Me puedes decir la fecha exacta? Por ejemplo: 15 de mayo de 2026."

Cuando tengas TODOS los datos, escribe en una sola línea al inicio de tu respuesta:
RESERVA_CONFIRMADA {"vehiculo":"...","sede":"...","fecha_inicio":"YYYY-MM-DD","fecha_fin":"YYYY-MM-DD","nombre":"...","telefono":"..."}
Luego escribe un mensaje de confirmación natural.

## REGLAS ADICIONALES
- Para consultas de taller o venta: da el teléfono de la sede más cercana o el general (637 55 85 33)
- Si no sabes algo: "Para eso lo mejor es que llames al 637 55 85 33 en horario de lunes a viernes"
- Recuerda que fines de semana estamos cerrados`;

function getContextoFecha() {
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const hoy = new Date();
  const diaTexto = `${dias[hoy.getDay()]} ${hoy.getDate()} de ${meses[hoy.getMonth()]} de ${hoy.getFullYear()}`;
  return `\n\n## FECHA ACTUAL\nHoy es ${diaTexto}. Usa esto para orientar al cliente. NUNCA calcules tú qué día de la semana cae una fecha concreta.`;
}

function getSystemPrompt() {
  const instrucciones = loadInstrucciones();
  let prompt = SYSTEM_PROMPT + getContextoFecha();
  if (instrucciones.length) {
    const extra = instrucciones.map(i => `- ${i.texto}`).join('\n');
    prompt += `\n\n## INSTRUCCIONES ADICIONALES DE GARMA (tienen prioridad sobre lo anterior)\n${extra}`;
  }
  return prompt;
}

// ── Validación de reserva ─────────────────────────────────────────────────────
function validarReserva(datos) {
  const errs = [];
  const isoRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!datos.fecha_inicio || !isoRegex.test(datos.fecha_inicio)) errs.push('fecha_inicio inválida (debe ser YYYY-MM-DD)');
  if (!datos.fecha_fin || !isoRegex.test(datos.fecha_fin)) errs.push('fecha_fin inválida (debe ser YYYY-MM-DD)');
  if (datos.fecha_inicio && datos.fecha_fin && datos.fecha_inicio > datos.fecha_fin) errs.push('fecha_fin debe ser posterior a fecha_inicio');
  if (!datos.nombre?.trim()) errs.push('nombre requerido');
  if (!datos.telefono?.trim()) errs.push('teléfono requerido');
  if (!datos.vehiculo?.trim()) errs.push('vehículo requerido');
  if (!datos.sede?.trim()) errs.push('sede requerida');
  return errs;
}

// ── Transferencia a humano ────────────────────────────────────────────────────
const FRASES_TRANSFERENCIA = [
  'hablar con una persona', 'hablar con alguien', 'persona real', 'humano',
  'no me ayudas', 'quiero hablar con', 'con el responsable', 'con el encargado',
  'con un agente', 'con ventas',
];
function quierePersonaReal(mensaje) {
  return FRASES_TRANSFERENCIA.some(f => mensaje.toLowerCase().includes(f));
}

// ── Lógica del agente ─────────────────────────────────────────────────────────
const reservasDuplicadas = new Set();

async function chatConAgente(sessionId, mensaje) {
  const historial = getHistorial(sessionId);

  if (quierePersonaReal(mensaje)) {
    historial.push({ role: 'user', content: mensaje });
    const respuesta = 'Entendido, voy a avisar al equipo para que contacten contigo. También puedes llamar directamente al 637 55 85 33 en horario de lunes a viernes.';
    historial.push({ role: 'assistant', content: respuesta });
    return { respuesta, reservaCreada: null, transferencia: true };
  }

  historial.push({ role: 'user', content: mensaje });

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 500,
    messages: [{ role: 'system', content: getSystemPrompt() }, ...historial],
  });

  const respuesta = response.choices[0].message.content;
  historial.push({ role: 'assistant', content: respuesta });

  let reservaCreada = null;
  if (respuesta.includes('RESERVA_CONFIRMADA')) {
    try {
      const jsonMatch = respuesta.match(/RESERVA_CONFIRMADA\s*(\{.*?\})/s);
      if (jsonMatch) {
        const datos = JSON.parse(jsonMatch[1]);
        const errs = validarReserva(datos);
        if (errs.length) {
          console.warn('[Reserva] Datos inválidos:', errs);
        } else {
          const clave = `${sessionId}-${datos.fecha_inicio}-${datos.fecha_fin}-${datos.nombre}`;
          if (!reservasDuplicadas.has(clave)) {
            reservasDuplicadas.add(clave);
            setTimeout(() => reservasDuplicadas.delete(clave), 60000);
            const reservas = loadReservas();
            const nueva = { id: Date.now(), ...datos, estado: 'confirmada', creadaEn: new Date().toISOString(), sessionId };
            reservas.push(nueva);
            saveReservas(reservas);
            reservaCreada = nueva;
            console.log('[Reserva] Creada:', nueva.nombre, nueva.vehiculo, nueva.fecha_inicio);
          } else {
            console.log('[Reserva] Duplicada ignorada para sesión', sessionId);
          }
        }
      }
    } catch (e) { console.error('Error parseando reserva:', e); }
  }

  const respuestaLimpia = respuesta.replace(/RESERVA_CONFIRMADA\s*\{.*?\}/s, '').trim();
  return { respuesta: respuestaLimpia, reservaCreada };
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.post('/api/chat', rateLimit, checkActive, async (req, res) => {
  const { sessionId, mensaje } = req.body;
  if (!sessionId || !mensaje || typeof mensaje !== 'string') {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }
  if (mensaje.length > 1000) return res.status(400).json({ error: 'Mensaje demasiado largo' });
  try {
    const resultado = await chatConAgente(sessionId, mensaje);
    res.json(resultado);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del agente' });
  }
});

app.get('/api/reservas', requireAdmin, (req, res) => res.json(loadReservas()));

app.patch('/api/reservas/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  const reservas = loadReservas();
  const idx = reservas.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  reservas[idx] = { ...reservas[idx], ...req.body };
  saveReservas(reservas);
  res.json(reservas[idx]);
});

app.delete('/api/reservas/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  saveReservas(loadReservas().filter(r => r.id !== id));
  res.json({ ok: true });
});

// ── Instrucciones al agente ───────────────────────────────────────────────────
app.get('/api/instrucciones', requireAdmin, (req, res) => res.json(loadInstrucciones()));

app.post('/api/instrucciones', requireAdmin, (req, res) => {
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'Texto requerido' });
  const instrucciones = loadInstrucciones();
  const nueva = { id: Date.now(), texto: texto.trim(), creadaEn: new Date().toISOString() };
  instrucciones.push(nueva);
  saveInstrucciones(instrucciones);
  res.json(nueva);
});

app.delete('/api/instrucciones/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });
  saveInstrucciones(loadInstrucciones().filter(i => i.id !== id));
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`✅ Garma Automoción agente corriendo en http://localhost:${PORT}`);
  console.log(`   Admin: http://localhost:${PORT}/admin.html`);
  console.log(`   Data dir: ${DATA_DIR}`);
});
