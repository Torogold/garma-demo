import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Base de datos ─────────────────────────────────────────────────────────────
const DB_PATH = join(__dirname, 'reservas.json');
function loadReservas() {
  if (!existsSync(DB_PATH)) return [];
  return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
}
function saveReservas(reservas) {
  writeFileSync(DB_PATH, JSON.stringify(reservas, null, 2));
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 20;
  if (!rateLimits.has(ip)) rateLimits.set(ip, []);
  const timestamps = rateLimits.get(ip).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento.' });
  }
  timestamps.push(now);
  rateLimits.set(ip, timestamps);
  next();
}

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

// ── Sesiones ──────────────────────────────────────────────────────────────────
const sesiones = new Map();

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente virtual de Garma Automoción, empresa de automoción con 39 años de experiencia en Extremadura y Salamanca.

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
Cuando el cliente quiera reservar un vehículo de alquiler, recoge estos datos:
1. Tipo de vehículo o necesidad (turismo, furgoneta, combi...)
2. Sede donde recoge el vehículo
3. Fecha de inicio del alquiler (dd/mm/yyyy)
4. Fecha de fin del alquiler (dd/mm/yyyy)
5. Nombre completo
6. Teléfono de contacto

Cuando tengas TODOS los datos confirma con:
RESERVA_CONFIRMADA {"vehiculo":"...","sede":"...","fecha_inicio":"YYYY-MM-DD","fecha_fin":"YYYY-MM-DD","nombre":"...","telefono":"..."}
Luego escribe un mensaje de confirmación natural.

## REGLAS
- Habla en español, tono profesional y cercano
- Máximo 3-4 frases por respuesta
- Para consultas de taller o venta: da el teléfono de la sede más cercana o el general (637 55 85 33)
- Si no sabes algo: "Para eso lo mejor es que llames al 637 55 85 33 en horario de atención"
- Recuerda que fines de semana estamos cerrados`;

// ── Transferencia a humano ────────────────────────────────────────────────────
const FRASES_TRANSFERENCIA = [
  'hablar con una persona', 'hablar con alguien', 'persona real', 'humano',
  'no me ayudas', 'quiero hablar con', 'con el responsable', 'con el encargado',
  'con un agente', 'con ventas',
];
function quierePersonaReal(mensaje) {
  return FRASES_TRANSFERENCIA.some(f => mensaje.toLowerCase().includes(f));
}

// ── Email con Resend ──────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_NEGOCIO = process.env.EMAIL_NEGOCIO || 'gestion@garmaautomocion.com';

async function enviarEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return console.log('[Email] Sin RESEND_API_KEY, omitiendo');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Agente IA <onboarding@resend.dev>', to, subject, html }),
  });
  const data = await res.json();
  console.log('[Email]', to, '→', data.id || data.message);
}

async function notificarNuevaReserva(r) {
  await enviarEmail({
    to: EMAIL_NEGOCIO,
    subject: `✅ Nueva reserva — ${r.nombre} · ${r.vehiculo}`,
    html: `<div style="font-family:sans-serif;max-width:500px">
      <h2 style="color:#1a3a5c">Nueva reserva de alquiler — Agente IA</h2>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Vehículo</td><td style="padding:8px">${r.vehiculo}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Sede</td><td style="padding:8px">${r.sede}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Fecha inicio</td><td style="padding:8px">${r.fecha_inicio}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Fecha fin</td><td style="padding:8px">${r.fecha_fin}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Cliente</td><td style="padding:8px">${r.nombre}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;font-weight:bold">Teléfono</td><td style="padding:8px">${r.telefono}</td></tr>
      </table>
    </div>`,
  });
}

async function notificarTransferencia(sessionId, historial) {
  const resumen = historial.map(m => `${m.role === 'user' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n');
  await enviarEmail({
    to: EMAIL_NEGOCIO,
    subject: `🔔 Cliente pide hablar con persona — sesión ${sessionId}`,
    html: `<div style="font-family:sans-serif;max-width:600px">
      <h2 style="color:#1a3a5c">Un cliente quiere hablar con vosotros</h2>
      <pre style="background:#f9f9f9;padding:16px;border-radius:8px;white-space:pre-wrap">${resumen}</pre>
    </div>`,
  });
}

// ── Lógica del agente ─────────────────────────────────────────────────────────
async function chatConAgente(sessionId, mensaje) {
  if (!sesiones.has(sessionId)) sesiones.set(sessionId, []);
  const historial = sesiones.get(sessionId);

  if (quierePersonaReal(mensaje)) {
    historial.push({ role: 'user', content: mensaje });
    const respuesta = 'Entendido, voy a avisar al equipo para que contacten contigo. También puedes llamar directamente al 637 55 85 33 en horario de lunes a viernes.';
    historial.push({ role: 'assistant', content: respuesta });
    notificarTransferencia(sessionId, historial).catch(console.error);
    return { respuesta, reservaCreada: null, transferencia: true };
  }

  historial.push({ role: 'user', content: mensaje });

  const response = await client.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 500,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...historial],
  });

  const respuesta = response.choices[0].message.content;
  historial.push({ role: 'assistant', content: respuesta });

  let reservaCreada = null;
  if (respuesta.includes('RESERVA_CONFIRMADA')) {
    try {
      const jsonMatch = respuesta.match(/RESERVA_CONFIRMADA\s*(\{.*?\})/s);
      if (jsonMatch) {
        const datos = JSON.parse(jsonMatch[1]);
        const reservas = loadReservas();
        const nueva = { id: Date.now(), ...datos, estado: 'confirmada', creadaEn: new Date().toISOString(), sessionId };
        reservas.push(nueva);
        saveReservas(reservas);
        reservaCreada = nueva;
        notificarNuevaReserva(nueva).catch(console.error);
      }
    } catch (e) { console.error('Error parseando reserva:', e); }
  }

  const respuestaLimpia = respuesta.replace(/RESERVA_CONFIRMADA\s*\{.*?\}/s, '').trim();
  return { respuesta: respuestaLimpia, reservaCreada };
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.post('/api/chat', rateLimit, checkActive, async (req, res) => {
  const { sessionId, mensaje } = req.body;
  if (!sessionId || !mensaje) return res.status(400).json({ error: 'Faltan parámetros' });
  try {
    const resultado = await chatConAgente(sessionId, mensaje);
    res.json(resultado);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del agente' });
  }
});

app.get('/api/reservas', (req, res) => res.json(loadReservas()));

app.patch('/api/reservas/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  const reservas = loadReservas();
  const idx = reservas.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  reservas[idx] = { ...reservas[idx], ...req.body };
  saveReservas(reservas);
  res.json(reservas[idx]);
});

app.delete('/api/reservas/:id', requireAdmin, (req, res) => {
  saveReservas(loadReservas().filter(r => r.id !== parseInt(req.params.id)));
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`✅ Garma Automoción agente corriendo en http://localhost:${PORT}`);
});
