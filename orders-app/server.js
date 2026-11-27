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
app.get('/api/prescription', (req, res) => {
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
