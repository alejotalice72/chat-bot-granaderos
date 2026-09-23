import express from 'express';
import crypto from 'crypto';

const {
  PORT = '3000',
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  APP_SECRET,
  GRAPH_VERSION = 'v23.0',
  HANDOFF_HOURS = '12',   // horas que el bot queda en silencio para que responda el personal
  SESSION_MINUTES = '30', // si el cliente abandona el menú, se reinicia tras este tiempo
} = process.env;

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('Faltan variables: WHATSAPP_TOKEN, PHONE_NUMBER_ID y/o VERIFY_TOKEN');
  process.exit(1);
}

const HANDOFF_MS = Number(HANDOFF_HOURS) * 60 * 60 * 1000;
const SESSION_MS = Number(SESSION_MINUTES) * 60 * 1000;

// ---------------------------------------------------------------------------
// FLUJO DEL MENÚ
// Límites de WhatsApp: máximo 3 botones por mensaje y 20 caracteres por botón.
// ---------------------------------------------------------------------------
const FLOW = {
  sucursal: {
    body: '¡Hola! 👋 Bienvenido/a.\n¿Con qué sector querés comunicarte?\n\n• Librería Colegio Nadino\n• Librería',
    label: 'Sector',
    options: () => [
      { id: 'colegio', title: 'Colegio Nadino', label: 'Librería Colegio Nadino' },
      { id: 'libreria', title: 'Librería', label: 'Librería' },
    ],
    next: () => 'servicio',
  },
  servicio: {
    body: '¿Qué necesitás?',
    label: 'Servicio',
    options: () => [
      { id: 'impresion', title: 'Impresión' },
      { id: 'consulta', title: 'Consulta' },
    ],
    next: (v) => (v === 'consulta' ? 'FIN_CONSULTA' : 'color'),
  },
  color: {
    body: '¿La impresión es en blanco y negro o color?',
    label: 'Tipo',
    options: () => [
      { id: 'bn', title: 'Blanco y negro' },
      { id: 'color', title: 'Color' },
    ],
    next: () => 'tamano',
  },
  tamano: {
    body: '¿Qué tamaño de hoja?',
    label: 'Tamaño',
    options: (raw) =>
      raw.color === 'bn'
        ? [{ id: 'a4', title: 'A4' }, { id: 'oficio', title: 'Oficio' }, { id: 'a3', title: 'A3' }]
        : [{ id: 'a4', title: 'A4' }, { id: 'oficio', title: 'Oficio' }],
    next: (_v, raw) => (raw.color === 'color' ? 'papel' : 'faz'),
  },
  papel: {
    body: '¿Qué tipo de papel?',
    label: 'Papel',
    options: () => [
      { id: 'comun', title: 'Papel común' },
      { id: 'foto', title: 'Papel fotográfico' },
      { id: 'adhesivo', title: 'Autoadhesivo', label: 'Papel autoadhesivo' },
    ],
    next: () => 'faz',
  },
  faz: {
    body: '¿Simple faz o doble faz?',
    label: 'Faz',
    options: () => [
      { id: 'simple', title: 'Simple faz' },
      { id: 'doble', title: 'Doble faz' },
    ],
    next: () => 'cantidad',
  },
  cantidad: {
    body: '¿Cuántas copias?',
    label: 'Cantidad',
    options: () => [
      { id: '1', title: '1' },
      { id: '2', title: '2' },
      { id: 'otro', title: 'Otro' },
    ],
    next: (v) => (v === 'otro' ? 'cantidad_otro' : 'FIN_PEDIDO'),
  },
};

const ORDER = ['sucursal', 'servicio', 'color', 'tamano', 'papel', 'faz', 'cantidad'];

// ---------------------------------------------------------------------------
// SESIONES (en memoria)
// ---------------------------------------------------------------------------
const sessions = new Map(); // telefono -> { step, raw, labels, updatedAt, handoffUntil }
const seenIds = new Set();

setInterval(() => {
  const limit = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, s] of sessions) {
    if (s.updatedAt < limit && (!s.handoffUntil || s.handoffUntil < Date.now())) sessions.delete(k);
  }
  if (seenIds.size > 5000) seenIds.clear();
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// API DE WHATSAPP
// ---------------------------------------------------------------------------
// Argentina: Meta envía 549XXXXXXXXXX pero para responder requiere 54XXXXXXXXXX
function toRecipient(n) {
  return n.startsWith('549') ? '54' + n.slice(3) : n;
}
async function callApi(payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload, to: toRecipient(payload.to) }),
  });
  if (!r.ok) console.error('Error API WhatsApp', r.status, await r.text());
}

const sendText = (to, body) => callApi({ to, type: 'text', text: { body } });

const sendButtons = (to, body, buttons) =>
  callApi({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });

function sendStep(to, s) {
  if (s.step === 'cantidad_otro') {
    return sendText(to, 'Escribí la cantidad de copias (solo el número, por ejemplo: 15).');
  }
  const def = FLOW[s.step];
  const opts = def.options(s.raw).map((o) => ({ id: `${s.step}:${o.id}`, title: o.title }));
  return sendButtons(to, def.body, opts);
}

// ---------------------------------------------------------------------------
// LÓGICA DEL BOT
// ---------------------------------------------------------------------------
function newSession() {
  return { step: 'sucursal', raw: {}, labels: {}, updatedAt: Date.now(), handoffUntil: 0 };
}

function summary(s) {
  return ORDER.filter((k) => s.labels[k])
    .map((k) => `${FLOW[k].label}: ${s.labels[k]}`)
    .join('\n');
}

async function finishOrder(to, s) {
  s.handoffUntil = Date.now() + HANDOFF_MS;
  console.log(`[PEDIDO] ${to}\n${summary(s)}`);
  await sendText(
    to,
    `✅ *Pedido recibido*\n\n${summary(s)}\n\n` +
      'Aguardá a que nuestro personal se comunique con vos para completar el trabajo. ¡Gracias!'
  );
}

async function finishConsulta(to, s) {
  s.handoffUntil = Date.now() + HANDOFF_MS;
  console.log(`[CONSULTA] ${to} - ${s.labels.sucursal}`);
  await sendText(to, '📝 Perfecto. Escribí tu consulta y un integrante del personal te va a responder a la brevedad.');
}

async function handleMessage(from, msg) {
  const now = Date.now();
  const text = msg.type === 'text' ? (msg.text?.body || '').trim() : '';
  const wantsMenu = /^(men[uú]|inicio)$/i.test(text);
  let s = sessions.get(from);

  // En atención humana: el bot no responde (salvo que el cliente escriba "menu")
  if (s?.handoffUntil > now && !wantsMenu) return;

  // Sesión nueva, vencida, finalizada o pedido explícito de menú
  if (!s || wantsMenu || s.handoffUntil || now - s.updatedAt > SESSION_MS) {
    s = newSession();
    sessions.set(from, s);
    return sendStep(from, s);
  }
  s.updatedAt = now;

  // Cantidad escrita a mano
  if (s.step === 'cantidad_otro') {
    if (!/^\d{1,5}$/.test(text) || Number(text) < 1) {
      return sendText(from, 'Por favor escribí solo la cantidad en números (por ejemplo: 15).');
    }
    s.labels.cantidad = text;
    return finishOrder(from, s);
  }

  // Respuesta con botón
  const replyId = msg.type === 'interactive' ? msg.interactive?.button_reply?.id : null;
  const [step, value] = (replyId || '').split(':');
  if (step !== s.step) return sendStep(from, s); // escribió texto o tocó un botón viejo: repetir pregunta

  const def = FLOW[s.step];
  const opt = def.options(s.raw).find((o) => o.id === value);
  if (!opt) return sendStep(from, s);

  s.raw[s.step] = value;
  s.labels[s.step] = opt.label || opt.title;

  const next = def.next(value, s.raw);
  if (next === 'FIN_CONSULTA') return finishConsulta(from, s);
  if (next === 'FIN_PEDIDO') return finishOrder(from, s);
  s.step = next;
  return sendStep(from, s);
}

// ---------------------------------------------------------------------------
// SERVIDOR / WEBHOOK
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function validSignature(req) {
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody || '').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/', (_req, res) => res.send('ok'));

// Verificación del webhook (Meta)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Mensajes entrantes
app.post('/webhook', (req, res) => {
  if (APP_SECRET && !validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);

  for (const entry of req.body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const msg of change.value?.messages || []) {
        if (seenIds.has(msg.id)) continue; // Meta puede reenviar el mismo mensaje
        seenIds.add(msg.id);
        handleMessage(msg.from, msg).catch((e) => console.error('Error procesando mensaje', e));
      }
    }
  }
});

app.listen(Number(PORT), () => console.log(`Bot escuchando en puerto ${PORT}`));
