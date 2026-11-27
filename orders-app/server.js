const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_PATH = path.join(DATA_DIR, 'orders.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ORDERS_PATH)) fs.writeFileSync(ORDERS_PATH, '[]');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function loadOrders() {
  return JSON.parse(fs.readFileSync(ORDERS_PATH, 'utf8'));
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(orders, null, 2));
}

function normalizePhone(raw) {
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
  return digits;
}

async function sendTemplate(toRaw, templateName, bodyParams) {
  const config = loadConfig();
  const to = normalizePhone(toRaw);
  const url = `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: config.templateLanguage || 'en_US' },
      components: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({ type: 'text', text: String(text) })),
        },
      ],
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error('WhatsApp send failed:', JSON.stringify(json));
      return { ok: false, error: json };
    }
    return { ok: true, result: json };
  } catch (err) {
    console.error('WhatsApp send error:', err);
    return { ok: false, error: String(err) };
  }
}

const GOOGLE_CREDS_PATH = path.join(__dirname, 'google-credentials.json');
let cachedGoogleToken = null; // { token, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Exchanges the service-account key for a short-lived Google API access token.
async function getGoogleAccessToken() {
  if (cachedGoogleToken && cachedGoogleToken.expiresAt > Date.now() + 60000) {
    return cachedGoogleToken.token;
  }
  if (!fs.existsSync(GOOGLE_CREDS_PATH)) return null;
  const creds = JSON.parse(fs.readFileSync(GOOGLE_CREDS_PATH, 'utf8'));

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(creds.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.error('Google auth failed:', JSON.stringify(json));
      return null;
    }
    cachedGoogleToken = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  } catch (err) {
    console.error('Google auth error:', err);
    return null;
  }
}

// Appends one row to the Google Sheet order log. Never throws -- a Sheets outage
// should never block an order from being placed or a WhatsApp message from sending.
async function logToSheet(order) {
  try {
    const config = loadConfig();
    const sheetId = config.googleSheetId;
    if (!sheetId) return;
    const token = await getGoogleAccessToken();
    if (!token) return;

    const rx = order.prescription || {};
    const row = [
      order.id,
      order.branch,
      order.customerName,
      order.phone,
      rx.r_sph || '',
      rx.r_cyl || '',
      rx.r_axis || '',
      rx.l_sph || '',
      rx.l_cyl || '',
      rx.l_axis || '',
      rx.add || '',
      rx.pd || '',
      new Date().toISOString(),
    ];

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      console.error('Sheet append failed:', JSON.stringify(errJson));
    }
  } catch (err) {
    console.error('Sheet append error:', err);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Protects the staff order-management endpoints with a simple 4-digit code.
// The customer-facing /api/prescription lookup is intentionally NOT behind this.
function checkPin(req, res, next) {
  const config = loadConfig();
  const required = config.staffPin;
  if (!required) return next(); // no pin configured yet -> don't lock anyone out
  const provided = req.headers['x-pin'] || req.query.pin;
  if (String(provided) !== String(required)) {
    return res.status(401).json({ error: 'Invalid access code' });
  }
  next();
}

// Return branch list (no secrets) so the frontend can build the branch selector.
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  res.json({ branches: Object.keys(config.branches) });
});

// List orders. ?branch=Dariyapur|Kasba  (omit or "All" for combined view)
app.get('/api/orders', checkPin, (req, res) => {
  const orders = loadOrders();
  const branch = req.query.branch;
  const filtered = !branch || branch === 'All' ? orders : orders.filter((o) => o.branch === branch);
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(filtered);
});

// Create a new order -> sends order_placed template
app.post('/api/orders', checkPin, async (req, res) => {
  const { branch, customerName, phone, prescription } = req.body;
  if (!branch || !customerName || !phone) {
    return res.status(400).json({ error: 'branch, customerName and phone are required' });
  }
  const config = loadConfig();
  if (!config.branches[branch]) {
    return res.status(400).json({ error: 'Unknown branch' });
  }

  const order = {
    id: crypto.randomUUID(),
    branch,
    customerName,
    phone,
    prescription: prescription || {},
    status: 'placed',
    createdAt: new Date().toISOString(),
    readyAt: null,
    collectedAt: null,
  };

  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);

  const sendResult = await sendTemplate(phone, 'order_placed', [customerName, branch]);
  logToSheet(order);
  res.json({ order, whatsapp: sendResult });
});

// Mark an order as ready -> sends order_ready template
app.post('/api/orders/:id/ready', checkPin, async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.status = 'ready';
  order.readyAt = new Date().toISOString();
  saveOrders(orders);

  const sendResult = await sendTemplate(order.phone, 'order_ready', [order.customerName, order.branch]);
  res.json({ order, whatsapp: sendResult });
});

// Mark an order as collected -> sends order_thankyou template with branch's review link
app.post('/api/orders/:id/collected', checkPin, async (req, res) => {
  const orders = loadOrders();
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const config = loadConfig();
  const reviewLink = (config.branches[order.branch] || {}).reviewLink || '';

  order.status = 'collected';
  order.collectedAt = new Date().toISOString();
  saveOrders(orders);

  const sendResult = await sendTemplate(order.phone, 'order_thankyou', [reviewLink]);
  res.json({ order, whatsapp: sendResult });
});

// Customer-facing lookup: find the most recent order for a phone number (across all branches)
// Allows cross-origin requests from the main website, since the prescription page lives there.
app.get('/api/prescription', (req, res) => {
  res.set('Access-Control-Allow-Origin', 'https://shivamopticals.co.in');
  const rawPhone = req.query.phone;
  if (!rawPhone) return res.status(400).json({ error: 'phone is required' });
  const target = normalizePhone(rawPhone);
  if (target.length < 12) return res.status(400).json({ error: 'Please enter a valid 10-digit number' });

  const orders = loadOrders();
  const matches = orders.filter((o) => normalizePhone(o.phone) === target);
  if (!matches.length) {
    return res.status(404).json({ error: 'No order found for this number' });
  }
  matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(matches[0]);
});

// Delete an order (for fixing mistaken entries)
app.delete('/api/orders/:id', checkPin, (req, res) => {
  let orders = loadOrders();
  const before = orders.length;
  orders = orders.filter((o) => o.id !== req.params.id);
  saveOrders(orders);
  res.json({ deleted: before - orders.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shivam Opticals order app listening on port ${PORT}`);
});
