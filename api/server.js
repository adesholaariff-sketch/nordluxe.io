const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Flutterwave = require('flutterwave-node-v3');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const AppleStrategy = require('passport-apple');
const session = require('express-session');
const { authenticator } = require('otplib');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

let firebaseAdminAuth = null;
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    firebaseAdminAuth = admin.auth();
  } catch (error) {
    console.error('Firebase Admin initialization error:', error.message);
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files
app.use(express.static('.'));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'nordluxe-secret',
  resave: false,
  saveUninitialized: false
}));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport strategies (only initialize if credentials are provided)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const users = readUsers();
      let user = users.find((u) => u.googleId === profile.id);
      if (!user) {
        user = {
          _id: crypto.randomBytes(12).toString('hex'),
          googleId: profile.id,
          email: profile.emails[0].value,
          name: profile.displayName,
          createdAt: new Date().toISOString()
        };
        users.push(user);
        writeUsers(users);
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }));
}

if (process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
  passport.use(new AppleStrategy({
    clientID: process.env.APPLE_CLIENT_ID,
    teamID: process.env.APPLE_TEAM_ID,
    callbackURL: '/auth/apple/callback',
    keyID: process.env.APPLE_KEY_ID,
    privateKeyLocation: process.env.APPLE_PRIVATE_KEY_PATH
  }, async (accessToken, refreshToken, idToken, profile, done) => {
    try {
      const users = readUsers();
      let user = users.find((u) => u.appleId === profile.id);
      if (!user) {
        user = {
          _id: crypto.randomBytes(12).toString('hex'),
          appleId: profile.id,
          email: profile.email,
          name: profile.name,
          createdAt: new Date().toISOString()
        };
        users.push(user);
        writeUsers(users);
      }
      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }));
}

passport.serializeUser((user, done) => {
  done(null, user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const users = readUsers();
    const user = users.find((u) => String(u._id) === String(id));
    done(null, user || null);
  } catch (err) {
    done(err, null);
  }
});

// Initialize Flutterwave
const flw = new Flutterwave(
  process.env.FLUTTERWAVE_PUBLIC_KEY,
  process.env.FLUTTERWAVE_SECRET_KEY
);

function hasConfiguredEnvValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (/your_|_here|replace_with|example/i.test(normalized)) return false;
  return true;
}

// Resend email client — set RESEND_API_KEY in your environment.
// The 'from' address must use a domain verified in your Resend dashboard.
const resend = hasConfiguredEnvValue(process.env.RESEND_API_KEY)
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Gmail email client
const gmailTransporter = hasConfiguredEnvValue(process.env.EMAIL_USER) && hasConfiguredEnvValue(process.env.EMAIL_PASS)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    })
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'NORDLUXE <noreply@nordluxe.io>';
const ORDERS_FALLBACK_FILE = path.join(__dirname, '..', '..', 'data', 'orders.json');

const LIVE_ACTIVITY_TTL_MS = Number(process.env.LIVE_ACTIVITY_TTL_MS || 120000);
const liveSessions = new Map();
const MAX_LIVE_EVENTS = Number(process.env.MAX_LIVE_EVENTS || 5000);
const liveEvents = [];
const confirmationEmailSentTxRefs = new Set();

async function sendTransactionalEmail(mailOptions) {
  console.log('Attempting to send transactional email to:', mailOptions.to, {
    resendConfigured: !!resend,
    gmailConfigured: !!gmailTransporter
  });

  if (resend) {
    await resend.emails.send(mailOptions);
    return 'resend';
  }

  if (gmailTransporter) {
    await gmailTransporter.sendMail(mailOptions);
    return 'gmail';
  }

  throw new Error('No email provider configured. Set RESEND_API_KEY or EMAIL_USER and EMAIL_PASS.');
}

function postJson(url, payload, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, headers || {})
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');

      response.on('data', (chunk) => {
        raw += chunk;
      });

      response.on('end', () => {
        if (!raw) {
          return resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            data: null
          });
        }

        try {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            data: JSON.parse(raw)
          });
        } catch (error) {
          reject(new Error(`Invalid JSON response from ${target.hostname}: ${raw.slice(0, 160)}`));
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

// ─── File-based User Storage ─────────────────────────────────────────────────

const USERS_FILE = path.join(__dirname, '..', '..', 'data', 'users.json');
const SUBSCRIBERS_FILE = path.join(__dirname, '..', '..', 'data', 'subscribers.json');

function ensureDataFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '[]', 'utf8');
}

function readUsers() {
  try {
    ensureDataFile(USERS_FILE);
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) { return []; }
}

function writeUsers(users) {
  ensureDataFile(USERS_FILE);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function readSubscribers() {
  try {
    ensureDataFile(SUBSCRIBERS_FILE);
    const raw = fs.readFileSync(SUBSCRIBERS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) { return []; }
}

function writeSubscribers(subscribers) {
  ensureDataFile(SUBSCRIBERS_FILE);
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2), 'utf8');
}

// ─── End File-based Storage ───────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value) {
  return String(value || '').trim();
}

const SINGLE_EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function extractSingleEmail(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return '';
  if (/[\r\n,;]/.test(normalized)) return '';
  if (!SINGLE_EMAIL_PATTERN.test(normalized)) return '';
  return normalized;
}

function derivePreferredCustomerName(candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeText(candidate);
    if (!normalized) {
      continue;
    }
    if (/^nordluxe$/i.test(normalized)) {
      continue;
    }
    return normalized;
  }
  return 'Valued Customer';
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveFrontendBaseUrl() {
  const fromEnv = normalizeText(process.env.FRONTEND_URL);
  if (fromEnv) {
    return trimTrailingSlash(fromEnv);
  }
  return `http://localhost:${PORT}`;
}

function resolveAbsoluteAssetUrl(assetPath) {
  const cleanedPath = `/${String(assetPath || '').replace(/^\/+/, '')}`;
  return `${resolveFrontendBaseUrl()}${cleanedPath}`;
}

const emailItemImageMap = {
  'Nordluxe Long Ascension White': '/assets/images/white%20long.png',
  'Nordluxe Short Ascension White': '/assets/images/wite%20short.png',
  'Nordluxe Long Ascension Black': '/assets/images/long%20black.png',
  'Nordluxe Short Ascension Black': '/assets/images/black%20short.png',
  'Cloak White': '/assets/images/cloak%20white.png',
  'Cloak Black': '/assets/images/cloak%20black.png',
  'Nordluxe Full Ascension White Bundle': '/assets/images/cloak%20white.png',
  'Nordluxe Full Ascension Black Bundle': '/assets/images/cloak%20black.png',
  'Full Package (White + Black) Complete Collection': '/assets/images/Full%20package.png'
};

function resolveOrderItemImageUrl(item) {
  if (!item || typeof item !== 'object') {
    return resolveAbsoluteAssetUrl('/assets/images/sa.jpg');
  }

  const directImage = normalizeText(item.image || item.imageUrl || item.img || item.thumbnail || '');
  if (directImage) {
    if (/^https?:\/\//i.test(directImage)) {
      return directImage;
    }
    return resolveAbsoluteAssetUrl(directImage);
  }

  const itemName = normalizeText(item.name || '');
  const normalizedName = itemName.replace(/\s*\([^)]*\)\s*$/, '');
  const mappedPath = emailItemImageMap[normalizedName] || emailItemImageMap[itemName] || '/assets/images/sa.jpg';
  return resolveAbsoluteAssetUrl(mappedPath);
}

function renderEmailLayout(options) {
  const title = escapeHtml(options && options.title ? options.title : 'NORDLUXE Update');
  const subtitle = escapeHtml(options && options.subtitle ? options.subtitle : 'Scandinavian Luxury Fashion');
  const preheader = escapeHtml(options && options.preheader ? options.preheader : 'NORDLUXE order update');
  const contentHtml = options && options.contentHtml ? options.contentHtml : '';
  const logoUrl = resolveAbsoluteAssetUrl('/assets/images/sa.jpg');
  const year = new Date().getFullYear();

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
      </head>
      <body style="margin:0;padding:0;background:#f3f0e8;font-family:Arial,Helvetica,sans-serif;color:#1f1b14;">
        <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f0e8;padding:24px 10px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border:1px solid #e5dbc6;border-radius:14px;overflow:hidden;">
                <tr>
                  <td style="padding:26px 28px;background:linear-gradient(135deg,#19140f,#3c2a18);text-align:center;">
                    <img src="${logoUrl}" alt="NORDLUXE" width="72" height="72" style="display:block;margin:0 auto 10px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);object-fit:cover;">
                    <div style="color:#f5dfb4;font-size:22px;letter-spacing:1.5px;font-weight:700;">NORDLUXE</div>
                    <div style="color:#dcb87a;font-size:12px;letter-spacing:1px;text-transform:uppercase;margin-top:4px;">${subtitle}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:28px;">
                    <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:#2d1f11;">${title}</h1>
                    ${contentHtml}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 28px;background:#faf7f1;border-top:1px solid #eee2cf;color:#5e513f;font-size:12px;line-height:1.6;">
                    <div style="font-weight:700;color:#6a4a20;">NORDLUXE</div>
                    <div>Scandinavian Luxury Fashion</div>
                    <div style="margin-top:4px;">© ${year} NORDLUXE. All rights reserved.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

function parseMoneyValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveItemUnitPrice(item) {
  if (!item || typeof item !== 'object') return null;

  const candidates = [
    item.depositPrice,
    item.finalPrice,
    item.price,
    item.preorderPrice,
    item.originalPrice,
    item.unitPrice
  ];

  for (const candidate of candidates) {
    const parsed = parseMoneyValue(candidate);
    if (parsed !== null && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function formatEmailCurrency(amount, currencyCode) {
  const value = Number.isFinite(amount) ? amount : 0;
  const hasFraction = Math.abs(value % 1) > 0;
  return `${escapeHtml(currencyCode || 'NGN')} ${value.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: hasFraction ? 2 : 0
  })}`;
}

function buildGroupedOrderLines(items) {
  const grouped = new Map();
  const list = Array.isArray(items) ? items : [];

  list.forEach((item, index) => {
    const name = normalizeText(item && item.name ? item.name : `Item ${index + 1}`) || `Item ${index + 1}`;
    const quantity = Number.isFinite(Number(item && item.quantity)) && Number(item.quantity) > 0
      ? Number(item.quantity)
      : 1;
    const unitPrice = resolveItemUnitPrice(item);
    const key = `${name}::${unitPrice === null ? 'na' : unitPrice.toFixed(2)}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        name,
        quantity: 0,
        unitPrice,
        lineTotal: 0
      });
    }

    const current = grouped.get(key);
    current.quantity += quantity;
    if (!current.imageUrl) {
      current.imageUrl = resolveOrderItemImageUrl(item);
    }
    if (unitPrice !== null) {
      current.lineTotal += unitPrice * quantity;
    }
  });

  return Array.from(grouped.values());
}

function buildOrderItemsTableHtml(items, currencyCode) {
  const lines = buildGroupedOrderLines(items);
  if (!lines.length) {
    return '<p><em>Item breakdown unavailable.</em></p>';
  }

  const hasUnknownLineTotals = lines.some((line) => line.unitPrice === null);
  const grandTotal = lines.reduce((sum, line) => {
    if (line.unitPrice === null) return sum;
    return sum + line.lineTotal;
  }, 0);
  const grandTotalHtml = hasUnknownLineTotals
    ? 'N/A'
    : formatEmailCurrency(grandTotal, currencyCode);

  const rows = lines.map((line) => {
    const unitPriceHtml = line.unitPrice !== null
      ? formatEmailCurrency(line.unitPrice, currencyCode)
      : 'N/A';
    const totalHtml = line.unitPrice !== null
      ? formatEmailCurrency(line.lineTotal, currencyCode)
      : 'N/A';

    return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #ececec;width:72px;">
          <img src="${escapeHtml(line.imageUrl || resolveAbsoluteAssetUrl('/assets/images/sa.jpg'))}" alt="${escapeHtml(line.name)}" width="56" height="56" style="display:block;border-radius:8px;object-fit:cover;border:1px solid #e6dcc8;">
        </td>
        <td style="padding:8px;border-bottom:1px solid #ececec;">${escapeHtml(line.name)}</td>
        <td style="padding:8px;border-bottom:1px solid #ececec;text-align:center;">${line.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #ececec;text-align:right;">${unitPriceHtml}</td>
        <td style="padding:8px;border-bottom:1px solid #ececec;text-align:right;">${totalHtml}</td>
      </tr>
    `;
  }).join('');

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:10px;">
      <thead>
        <tr style="background:#f3f3f3;">
          <th style="padding:8px;text-align:left;border-bottom:1px solid #ddd;">Image</th>
          <th style="padding:8px;text-align:left;border-bottom:1px solid #ddd;">Product</th>
          <th style="padding:8px;text-align:center;border-bottom:1px solid #ddd;">Qty</th>
          <th style="padding:8px;text-align:right;border-bottom:1px solid #ddd;">Unit Price</th>
          <th style="padding:8px;text-align:right;border-bottom:1px solid #ddd;">Line Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr style="background:#fbfbfb;">
          <td colspan="4" style="padding:10px;border-top:2px solid #ddd;text-align:right;font-weight:bold;">Grand Total:</td>
          <td style="padding:10px;border-top:2px solid #ddd;text-align:right;font-weight:bold;">${grandTotalHtml}</td>
        </tr>
      </tfoot>
    </table>
  `;
}

function ensureFallbackStore() {
  const dir = path.dirname(ORDERS_FALLBACK_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(ORDERS_FALLBACK_FILE)) {
    fs.writeFileSync(ORDERS_FALLBACK_FILE, '[]', 'utf8');
  }
}

function readFallbackOrders() {
  try {
    ensureFallbackStore();
    const raw = fs.readFileSync(ORDERS_FALLBACK_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Fallback order read error:', err.message);
    return [];
  }
}

function writeFallbackOrders(orders) {
  ensureFallbackStore();
  fs.writeFileSync(ORDERS_FALLBACK_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function sortByCreatedDesc(items) {
  return items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function getOrdersForQuery(query) {
  const list = readFallbackOrders();
  if (query && query.customerEmail instanceof RegExp) {
    return sortByCreatedDesc(list.filter((item) => query.customerEmail.test(String(item.customerEmail || ''))));
  }
  if (query && query.$or && Array.isArray(query.$or)) {
    const uid = query.$or.find((x) => Object.prototype.hasOwnProperty.call(x, 'userId'));
    const email = query.$or.find((x) => x.customerEmail instanceof RegExp);
    return sortByCreatedDesc(list.filter((item) => {
      const uidMatch = uid ? String(item.userId || '') === String(uid.userId || '') : false;
      const emailMatch = email ? email.customerEmail.test(String(item.customerEmail || '')) : false;
      return uidMatch || emailMatch;
    }));
  }
  return sortByCreatedDesc(list);
}

function generateOrderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let token = '';
  for (let i = 0; i < 8; i++) {
    token += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return `NLX-${token}`;
}

function displayOrderId(order) {
  return order && order.orderCode ? order.orderCode : order._id.toString().slice(-8).toUpperCase();
}

function normalizePagePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '/';
  let normalized = raw;
  if (/^https?:\/\//i.test(normalized)) {
    try {
      normalized = new URL(normalized).pathname || '/';
    } catch (err) {
      normalized = '/';
    }
  }
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized.split('?')[0].split('#')[0] || '/';
}

function cleanupLiveSessions() {
  const cutoff = Date.now() - LIVE_ACTIVITY_TTL_MS;
  for (const [sessionId, entry] of liveSessions.entries()) {
    if (!entry || Number(entry.lastSeenAt || 0) < cutoff) {
      liveSessions.delete(sessionId);
    }
  }
}

function buildLiveAnalyticsSnapshot() {
  cleanupLiveSessions();

  const perPage = {};
  for (const entry of liveSessions.values()) {
    const page = normalizePagePath(entry.page || '/');
    perPage[page] = (perPage[page] || 0) + 1;
  }

  const pages = Object.entries(perPage)
    .map(([page, count]) => ({ page, count }))
    .sort((a, b) => b.count - a.count);

  return {
    activeVisitors: liveSessions.size,
    pages,
    updatedAt: new Date().toISOString()
  };
}

function pushLiveEvent(event) {
  const normalized = event || {};
  liveEvents.unshift(normalized);
  if (liveEvents.length > MAX_LIVE_EVENTS) {
    liveEvents.length = MAX_LIVE_EVENTS;
  }
}

// Routes

app.post('/api/request-checkout-link', async (req, res) => {
  try {
    const { customer, items, total, currency, notes } = req.body;
    const firstName = normalizeText(customer && customer.firstName);
    const lastName = normalizeText(customer && customer.lastName);
    const email = normalizeText(customer && customer.email);
    const phone = normalizeText(customer && customer.phone);
    const address = normalizeText(customer && customer.address);
    const city = normalizeText(customer && customer.city);
    const state = normalizeText(customer && customer.state);
    const zipCode = normalizeText(customer && customer.zipCode);
    const country = normalizeText(customer && customer.country);

    if (!firstName || !lastName || !email || !phone || !address || !city || !zipCode || !country) {
      return res.status(400).json({
        success: false,
        message: 'Please provide complete customer information'
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart items are required'
      });
    }

    const numericTotal = Number(total);
    if (!Number.isFinite(numericTotal) || numericTotal <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order total'
      });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Email service is not configured on server'
      });
    }

    const recipient = 'nordl.luxe01@gmail.com';
    const safeNotes = normalizeText(notes);
    const currencyCode = 'NGN';

    const itemsHtml = buildOrderItemsTableHtml(items, currencyCode);

    await resend.emails.send({
      from: EMAIL_FROM,
      to: recipient,
      subject: 'NORDLUXE - New Checkout Link Request',
      html: renderEmailLayout({
        title: 'New Checkout Request',
        subtitle: 'Store Team Notification',
        preheader: 'A customer requested a secure checkout link.',
        contentHtml: `
          <p style="margin:0 0 14px;line-height:1.7;">A customer requested a checkout link. Please follow up to continue payment.</p>

          <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
            <h3 style="margin:0 0 10px;color:#6e4b1e;">Customer Information</h3>
            <p style="margin:0 0 6px;"><strong>Name:</strong> ${escapeHtml(firstName)} ${escapeHtml(lastName)}</p>
            <p style="margin:0 0 6px;"><strong>Email:</strong> ${escapeHtml(email)}</p>
            <p style="margin:0 0 6px;"><strong>Phone:</strong> ${escapeHtml(phone)}</p>
            <p style="margin:0;"><strong>Address:</strong> ${escapeHtml(address)}, ${escapeHtml(city)}, ${escapeHtml(state || 'N/A')} ${escapeHtml(zipCode)}, ${escapeHtml(country)}</p>
          </div>

          <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
            <h3 style="margin:0 0 10px;color:#6e4b1e;">Order Details</h3>
            <p style="margin:0 0 10px;"><strong>Total:</strong> ${escapeHtml(currencyCode)} ${numericTotal.toFixed(2)}</p>
            ${itemsHtml}
            <p style="margin:12px 0 0;"><strong>Notes:</strong> ${escapeHtml(safeNotes || 'None')}</p>
          </div>
        `
      })
    });

    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'NORDLUXE - Checkout Request Received',
      html: renderEmailLayout({
        title: 'Checkout Request Received',
        subtitle: 'Your NORDLUXE Request Is In',
        preheader: 'We received your checkout request and will send your secure payment link shortly.',
        contentHtml: `
          <p style="margin:0 0 14px;line-height:1.7;">Hi ${escapeHtml(firstName)},</p>
          <p style="margin:0 0 14px;line-height:1.7;">Thank you for your order request. Our team will contact you shortly and send your secure checkout link.</p>
          <p style="margin:0 0 14px;line-height:1.7;"><strong>Order total:</strong> ${escapeHtml(currencyCode)} ${numericTotal.toFixed(2)}</p>
          <p style="margin:0;line-height:1.7;">If you need immediate help, reply to this email and our team will assist you.</p>
        `
      })
    });

    res.json({
      success: true,
      message: 'Checkout request sent successfully. We will contact you with your checkout link.'
    });
  } catch (error) {
    console.error('Checkout request error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send checkout request',
      error: error.message
    });
  }
});

// Initialize payment
app.post('/api/initiate-payment', async (req, res) => {
  try {
    const { amount, currency, customer, items, paymentPlan, redirect_url } = req.body;
    const customerEmail = extractSingleEmail(customer && customer.email);
    const customerName = normalizeText(customer && customer.name);
    const authenticatedEmail = extractSingleEmail(req && req.user && req.user.email);

    if (!customerEmail) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid single customer email address.'
      });
    }

    if (!customerName) {
      return res.status(400).json({
        success: false,
        message: 'Please provide the customer name.'
      });
    }

    // Optional but recommended: if session user exists, require checkout email to match.
    if (authenticatedEmail && authenticatedEmail !== customerEmail) {
      return res.status(403).json({
        success: false,
        message: 'Checkout email must match the signed-in account email.'
      });
    }

    // Check if customer already has an order
    const fallbackOrders = readFallbackOrders();
    const existingCustomerOrder = fallbackOrders.find(order => 
      normalizeText(order.customerEmail) === normalizeText(customerEmail)
    );

    // Always create a fresh transaction reference so Flutterwave returns
    // a new hosted checkout link instead of an old/expired session.
    const tx_ref = `nl-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const payload = {
      tx_ref: tx_ref,
      amount: amount,
      currency: currency || 'NGN',
      redirect_url: redirect_url || `${process.env.FRONTEND_URL}/thank-you.html`,
      payment_options: 'card,mobilemoney,ussd',
      customer: {
        email: customerEmail,
        phonenumber: customer.phone,
        name: customerName
      },
      meta: {
        paymentType: paymentPlan && paymentPlan.type ? paymentPlan.type : 'standard',
        customerEmail: customerEmail,
        customerName: customerName,
        authenticatedUserEmail: authenticatedEmail || null,
        depositPercentage: paymentPlan && paymentPlan.depositPercentage ? paymentPlan.depositPercentage : null,
        balancePercentage: paymentPlan && paymentPlan.balancePercentage ? paymentPlan.balancePercentage : null,
        preorderTotal: paymentPlan && typeof paymentPlan.preorderTotal === 'number' ? paymentPlan.preorderTotal : null,
        depositAmount: paymentPlan && typeof paymentPlan.depositAmount === 'number' ? paymentPlan.depositAmount : amount,
        remainingBalance: paymentPlan && typeof paymentPlan.remainingBalance === 'number' ? paymentPlan.remainingBalance : null
      },
      customizations: {
        title: paymentPlan && paymentPlan.type === 'preorder-deposit' ? 'NORDLUXE Preorder Deposit' : 'NORDLUXE Purchase',
        description: paymentPlan && paymentPlan.type === 'preorder-deposit' ? '40% preorder deposit payment' : 'Luxury Scandinavian Fashion',
        logo: `${process.env.FRONTEND_URL}/sa.jpg`
      }
    };

    if (!process.env.FLUTTERWAVE_SECRET_KEY) {
      throw new Error('FLUTTERWAVE_SECRET_KEY is missing.');
    }

    const flutterwaveResponse = await postJson('https://api.flutterwave.com/v3/payments', payload, {
      Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`
    });

    const response = flutterwaveResponse.data;
    if (!flutterwaveResponse.ok || response.status !== 'success') {
      throw new Error(response.message || `Flutterwave request failed with status ${flutterwaveResponse.status}`);
    }

    // Save/update order to file store
    if (existingCustomerOrder) {
      // Update existing order by adding new items
      const orderIndex = fallbackOrders.findIndex(order => 
        normalizeText(order.customerEmail) === normalizeText(customerEmail)
      );
      
      if (orderIndex !== -1) {
        // Add new items to existing order
        const existingItems = Array.isArray(fallbackOrders[orderIndex].items) ? fallbackOrders[orderIndex].items : [];
        const newItems = Array.isArray(items) ? items : [];
        fallbackOrders[orderIndex].items = [...existingItems, ...newItems];
        
        // Update total amount (add to existing total)
        fallbackOrders[orderIndex].totalAmount = (fallbackOrders[orderIndex].totalAmount || 0) + (Number(amount) || 0);

        // Keep references aligned with the latest initiated payment.
        fallbackOrders[orderIndex].flutterwaveRef = payload.tx_ref;
        fallbackOrders[orderIndex].paymentReference = payload.tx_ref;
        fallbackOrders[orderIndex].status = 'pending';
        
        // Update timestamp
        fallbackOrders[orderIndex].updatedAt = new Date().toISOString();
        
        writeFallbackOrders(fallbackOrders);
      }
    } else {
      // Create new order for new customer
      fallbackOrders.unshift({
        _id: `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        customerEmail: customerEmail,
        customerName: customerName,
        items: Array.isArray(items) ? items : [],
        totalAmount: Number(amount) || 0,
        paymentPlan: paymentPlan || null,
        flutterwaveRef: payload.tx_ref,
        paymentReference: payload.tx_ref,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      writeFallbackOrders(fallbackOrders);
    }

    const responseData = response && response.data ? response.data : null;
    const paymentLink = responseData && responseData.link ? responseData.link : null;

    if (!paymentLink) {
      throw new Error('Flutterwave did not return a hosted payment link.');
    }

    res.json({
      success: true,
      data: {
        link: paymentLink,
        tx_ref: payload.tx_ref,
        raw: responseData
      }
    });

  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment initiation failed',
      error: error.message
    });
  }
});

// Verify payment
app.get('/api/verify-payment/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const response = await flw.Transaction.verify({ id: transactionId });

    if (response.data.status === 'successful') {
      // Update order status in file store
      const verifyOrders = readFallbackOrders();
      const verifyIdx = verifyOrders.findIndex((o) => o.flutterwaveRef === response.data.tx_ref);
      if (verifyIdx >= 0) {
        verifyOrders[verifyIdx].status = 'confirmed';
        verifyOrders[verifyIdx].confirmedAt = new Date().toISOString();
        writeFallbackOrders(verifyOrders);
      }

      // Confirmation is sent via /send-confirmation using the checkout form email.

      res.json({
        success: true,
        message: 'Payment verified successfully',
        data: response.data
      });
    } else {
      res.json({
        success: false,
        message: 'Payment not successful',
        data: response.data
      });
    }

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: error.message
    });
  }
});

// Flutterwave webhook
app.post('/api/webhook', async (req, res) => {
  const secretHash = process.env.FLUTTERWAVE_SECRET_HASH;
  const signature = req.headers['verif-hash'];

  if (!signature || signature !== secretHash) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  const payload = req.body;

  // Verify the event
  if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
    console.log('Payment completed:', payload.data);

    // Buyer confirmation is handled by /send-confirmation from checkout flow.

    // Update order status in file store
    try {
      const fallbackOrders = readFallbackOrders();
      const txRef = normalizeText(payload && payload.data && payload.data.tx_ref);
      const index = fallbackOrders.findIndex((item) => normalizeText(item && item.flutterwaveRef) === txRef);
      if (index >= 0) {
        fallbackOrders[index] = {
          ...fallbackOrders[index],
          status: 'confirmed',
          confirmedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        writeFallbackOrders(fallbackOrders);
      }
    } catch (err) {
      console.error('File store status update error:', err.message);
    }
  }

  res.status(200).json({ status: 'ok' });
});

app.post('/send-confirmation', async (req, res) => {
  try {
    const email = extractSingleEmail(req && req.body ? req.body.email : '');
    const sessionEmail = extractSingleEmail(req && req.user ? req.user.email : '');

    if (!email) {
      return res.status(400).json({ error: 'No email provided' });
    }

    if (sessionEmail && sessionEmail !== email) {
      return res.status(403).json({ error: 'Checkout email must match signed-in account email' });
    }

    console.log('Sending email to:', email);

    await sendTransactionalEmail({
      from: EMAIL_FROM,
      to: email,
      subject: 'Order Confirmation',
      html: '<h1>Thank you for your purchase</h1>'
    });

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Email failed' });
  }
});

async function findOrderByFlutterwaveRef(txRef) {
  const normalized = normalizeText(txRef);
  if (!normalized) return null;

  const fallbackOrders = readFallbackOrders();
  return fallbackOrders.find((item) => String(item.flutterwaveRef || '') === normalized) || null;
}

// Send order confirmation email
async function sendOrderConfirmationEmail(paymentData, authenticatedUserEmail) {
  const paymentMeta = paymentData.meta || {};
  const isPreorderDeposit = paymentMeta.paymentType === 'preorder-deposit';
  const txRef = paymentData && paymentData.tx_ref ? String(paymentData.tx_ref).trim() : '';
  const currencyCode = paymentData && paymentData.currency ? String(paymentData.currency) : 'NGN';

  // Prevent duplicate sends for same transaction
  if (txRef && confirmationEmailSentTxRefs.has(txRef)) {
    console.log('Skipping duplicate confirmation email send', { tx_ref: txRef });
    return;
  }

  if (txRef) {
    confirmationEmailSentTxRefs.add(txRef);
  }

  // Strict rule: confirmation goes only to checkout form email.
  const formEmail = extractSingleEmail(paymentMeta && paymentMeta.customerEmail);
  const sessionEmail = extractSingleEmail(authenticatedUserEmail || (paymentMeta && paymentMeta.authenticatedUserEmail));

  if (!formEmail) {
    console.error('Order confirmation email skipped: missing checkout form email', {
      tx_ref: txRef || null,
      transactionId: paymentData && paymentData.id ? paymentData.id : null,
      meta: paymentMeta
    });
    return;
  }

  // Optional protection: if session email exists, require exact match.
  if (sessionEmail && sessionEmail !== formEmail) {
    console.error('Order confirmation email blocked: form email does not match session user email', {
      tx_ref: txRef || null,
      transactionId: paymentData && paymentData.id ? paymentData.id : null,
      sessionEmail,
      formEmail
    });
    return;
  }

  // Get order details if available
  const matchedOrder = txRef ? await findOrderByFlutterwaveRef(txRef) : null;
  const orderItems = matchedOrder && Array.isArray(matchedOrder.items) ? matchedOrder.items : [];
  const orderedItemsHtml = buildOrderItemsTableHtml(orderItems, currencyCode);

  // Use form-provided name, fallback to payment data if needed
  const customerDisplayName = derivePreferredCustomerName([
    paymentMeta && paymentMeta.customerName,
    paymentData && paymentData.customer && paymentData.customer.name
  ]);

  const mailOptions = {
    from: EMAIL_FROM,
    to: formEmail,
    subject: isPreorderDeposit ? 'NORDLUXE - Preorder Deposit Confirmation' : 'NORDLUXE - Order Confirmation',
    html: renderEmailLayout({
      title: isPreorderDeposit ? 'Your Preorder Deposit Has Been Received' : 'Thank You For Your Purchase',
      subtitle: isPreorderDeposit ? 'Deposit Confirmation' : 'Order Confirmation',
      preheader: isPreorderDeposit ? 'Your NORDLUXE preorder deposit has been confirmed.' : 'Your NORDLUXE order has been confirmed.',
      contentHtml: `
        <p style="margin:0 0 14px;line-height:1.7;">Dear ${escapeHtml(customerDisplayName)},</p>
        <p style="margin:0 0 14px;line-height:1.7;">${isPreorderDeposit ? 'Your 40% preorder deposit has been successfully processed. Here are your order details:' : 'Your order has been successfully processed. Here are your order details:'}</p>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="margin:0 0 10px;color:#6e4b1e;">Payment Details</h3>
          <p style="margin:0 0 6px;"><strong>Transaction ID:</strong> ${escapeHtml(paymentData.id)}</p>
          <p style="margin:0 0 6px;"><strong>Amount Paid:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentData.amount)}</p>
          ${isPreorderDeposit && paymentMeta.preorderTotal ? `<p style="margin:0 0 6px;"><strong>Full Preorder Total:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentMeta.preorderTotal)}</p>` : ''}
          ${isPreorderDeposit && paymentMeta.remainingBalance ? `<p style="margin:0 0 6px;"><strong>Remaining Balance:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentMeta.remainingBalance)}</p>` : ''}
          <p style="margin:0 0 6px;"><strong>Payment Method:</strong> ${escapeHtml(paymentData.payment_type || 'N/A')}</p>
          <p style="margin:0;"><strong>Date:</strong> ${escapeHtml(new Date(paymentData.created_at).toLocaleDateString())}</p>
        </div>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="margin:0 0 10px;color:#6e4b1e;">Items Ordered</h3>
          ${orderedItemsHtml}
        </div>

        <p style="margin:0;line-height:1.7;">${isPreorderDeposit ? 'We will contact you when your piece is ready so you can complete the remaining 60% payment before delivery.' : 'You will receive a shipping confirmation email once your order ships.'}</p>
      `
    })
  };

  try {
    const provider = await sendTransactionalEmail(mailOptions);
    console.log('Order confirmation email sent', {
      to: formEmail,
      provider,
      tx_ref: txRef || null,
      transactionId: paymentData && paymentData.id ? paymentData.id : null
    });
  } catch (error) {
    console.error('Email sending error:', {
      to: formEmail,
      tx_ref: txRef || null,
      transactionId: paymentData && paymentData.id ? paymentData.id : null,
      error: error && error.message ? error.message : error
    });
    if (txRef) {
      confirmationEmailSentTxRefs.delete(txRef);
    }
  }
}

// Send payment notification to store owner
async function sendPaymentNotificationEmail(paymentData) {
  const adminEmail = extractSingleEmail(process.env.ADMIN_EMAIL);
  if (!adminEmail) {
    console.error('Admin notification email skipped: invalid ADMIN_EMAIL setting.');
    return;
  }

  const matchedOrder = await findOrderByFlutterwaveRef(paymentData.tx_ref);
  const orderItems = matchedOrder && Array.isArray(matchedOrder.items) ? matchedOrder.items : [];
  const itemsHtml = buildOrderItemsTableHtml(orderItems, paymentData && paymentData.currency ? paymentData.currency : 'NGN');

  const paymentMeta = paymentData.meta || {};
  const isPreorderDeposit = paymentMeta.paymentType === 'preorder-deposit';
  const mailOptions = {
    from: EMAIL_FROM,
    to: adminEmail,
    subject: isPreorderDeposit ? 'NEW PREORDER DEPOSIT - NORDLUXE Order Received' : 'NEW SALE - NORDLUXE Order Received',
    html: renderEmailLayout({
      title: isPreorderDeposit ? 'New Preorder Deposit Alert' : 'New Sale Alert',
      subtitle: 'Store Team Notification',
      preheader: isPreorderDeposit ? 'A new preorder deposit has been received.' : 'A new order payment has been received.',
      contentHtml: `
        <p style="margin:0 0 14px;line-height:1.7;">${isPreorderDeposit ? 'You have received a new preorder deposit:' : 'You have received a new order:'}</p>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="margin:0 0 10px;color:#6e4b1e;">Customer Details</h3>
          <p style="margin:0 0 6px;"><strong>Name:</strong> ${escapeHtml(paymentData.customer && paymentData.customer.name ? paymentData.customer.name : 'N/A')}</p>
          <p style="margin:0 0 6px;"><strong>Email:</strong> ${escapeHtml(paymentData.customer && paymentData.customer.email ? paymentData.customer.email : 'N/A')}</p>
          <p style="margin:0;"><strong>Phone:</strong> ${escapeHtml(paymentData.customer && paymentData.customer.phone ? paymentData.customer.phone : 'Not provided')}</p>
        </div>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="margin:0 0 10px;color:#6e4b1e;">Payment Details</h3>
          <p style="margin:0 0 6px;"><strong>Transaction ID:</strong> ${escapeHtml(paymentData.id)}</p>
          <p style="margin:0 0 6px;"><strong>Reference:</strong> ${escapeHtml(paymentData.tx_ref)}</p>
          <p style="margin:0 0 6px;"><strong>Amount:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentData.amount)}</p>
          ${isPreorderDeposit && paymentMeta.preorderTotal ? `<p style="margin:0 0 6px;"><strong>Full Preorder Total:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentMeta.preorderTotal)}</p>` : ''}
          ${isPreorderDeposit && paymentMeta.remainingBalance ? `<p style="margin:0 0 6px;"><strong>Remaining Balance:</strong> ${escapeHtml(paymentData.currency)} ${escapeHtml(paymentMeta.remainingBalance)}</p>` : ''}
          <p style="margin:0 0 6px;"><strong>Payment Method:</strong> ${escapeHtml(paymentData.payment_type || 'N/A')}</p>
          <p style="margin:0 0 6px;"><strong>Status:</strong> ${escapeHtml(paymentData.status || 'N/A')}</p>
          <p style="margin:0;"><strong>Date:</strong> ${escapeHtml(new Date(paymentData.created_at).toLocaleString())}</p>
        </div>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="margin:0 0 10px;color:#6e4b1e;">Items Ordered</h3>
          ${itemsHtml}
        </div>

        <p style="margin:0;line-height:1.7;">${isPreorderDeposit ? 'Please track production and request the remaining 60% once the piece is ready.' : 'Please process this order promptly.'}</p>
      `
    })
  };

  try {
    const provider = await sendTransactionalEmail(mailOptions);
    console.log('Payment notification email sent to admin', { provider });
  } catch (error) {
    console.error('Admin notification email error:', error && error.message ? error.message : error);
  }
}

// Send preorder final payment reminder email
async function sendPreorderReminderEmail(order) {
  const recipientEmail = extractSingleEmail(order.customerEmail);
  if (!recipientEmail) {
    console.error('Reminder email skipped: missing customer email');
    return;
  }

  const remainingAmount = Math.round(order.totalAmount * 0.6 * 100) / 100;
  const dashboardLink = `${process.env.FRONTEND_URL || 'http://localhost:8000'}/orders.html`;

  const mailOptions = {
    from: EMAIL_FROM,
    to: recipientEmail,
    subject: 'NORDLUXE - 7 Days to Your Preorder! Final Payment Due Soon',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #d19b48;">Your NORDLUXE Preorder is Almost Here! 🎉</h2>
        
        <p>Dear ${escapeHtml(order.customerName)},</p>
        <p>Your luxury NORDLUXE piece will arrive in just 7 days! To ensure timely delivery, we need the final payment.</p>

        <div style="background:#f8f4eb;border:1px solid #e8dcc7;border-radius:12px;padding:16px;margin:16px 0;">
          <h3 style="color:#6e4b1e;margin-top:0;">⏰ Final Payment Details</h3>
          <p><strong>Order ID:</strong> ${escapeHtml(order.flutterwaveRef)}</p>
          <p><strong>Item:</strong> ${order.items && order.items[0] ? escapeHtml(order.items[0].itemName) : 'Your Order'}</p>
          <p style="font-size:1.1em;"><strong>Remaining Balance (60%):</strong> <span style="color:#d19b48;">${escapeHtml(order.currency)} ${remainingAmount}</span></p>
          <p style="margin-bottom:0;"><strong>Due Date:</strong> Within 7 days for on-time delivery</p>
        </div>

        <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:12px;padding:16px;margin:16px 0;">
          <p style="margin:0;"><strong>🔐 Secure Payment</strong><br>Your payment is processed securely through Flutterwave.</p>
        </div>

        <p style="text-align:center;margin:20px 0;">
          <a href="${dashboardLink}" style="display:inline-block;background:#d19b48;color:white;padding:12px 30px;text-decoration:none;border-radius:8px;font-weight:600;">Access Your Dashboard & Pay</a>
        </p>

        <p>If you have any questions, feel free to contact us.</p>
        
        <p style="border-top:1px solid #e8dcc7;padding-top:20px;margin-top:30px;">
          Best regards,<br>
          <strong style="color:#d19b48;">NORDLUXE Team</strong><br>
          Luxury Scandinavian Fashion
        </p>
      </div>
    `
  };

  try {
    const provider = await sendTransactionalEmail(mailOptions);
    console.log('Preorder reminder email sent', { to: recipientEmail, orderId: order.flutterwaveRef, provider });
  } catch (error) {
    console.error('Reminder email send error:', error.message);
  }
}

// Scheduled task to send reminder emails
function setupReminderEmailScheduler() {
  // Run every hour
  setInterval(() => {
    checkAndSendReminders();
  }, 60 * 60 * 1000);
  
  // Also run on startup after 5 minutes
  setTimeout(() => {
    checkAndSendReminders();
  }, 5 * 60 * 1000);
}

async function checkAndSendReminders() {
  try {
    const orders = readFallbackOrders();
    const now = new Date();

    orders.forEach(order => {
      // Only for pending preorders that haven't paid full amount
      if (order.status !== 'confirmed' || !order.createdAt) return;

      const orderDate = new Date(order.createdAt);
      const deliveryDate = new Date(orderDate);
      deliveryDate.setDate(deliveryDate.getDate() + 20);

      // Calculate days until delivery
      const daysUntilDelivery = Math.ceil((deliveryDate - now) / (1000 * 60 * 60 * 24));

      // Send reminder if 7 days before delivery and hasn't been reminded yet
      if (daysUntilDelivery === 7 && !order.reminderEmailSent) {
        sendPreorderReminderEmail(order);
        
        // Mark as reminder sent
        const index = orders.findIndex(o => o.flutterwaveRef === order.flutterwaveRef);
        if (index >= 0) {
          orders[index].reminderEmailSent = true;
          orders[index].reminderSentAt = new Date().toISOString();
          writeFallbackOrders(orders);
        }
      }
    });
  } catch (error) {
    console.error('Reminder scheduler error:', error.message);
  }
}

// Auth routes
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

  app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login.html' }), (req, res) => {
    res.redirect('/index.html');
  });
} else {
  app.get('/auth/google', (req, res) => {
    res.status(503).send('Google login is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart the server.');
  });

  app.get('/auth/google/callback', (req, res) => {
    res.redirect('/login.html');
  });
}

if (process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
  app.get('/auth/apple', passport.authenticate('apple'));

  app.get('/auth/apple/callback', passport.authenticate('apple', { failureRedirect: '/login.html' }), (req, res) => {
    res.redirect('/index.html');
  });
}

// Email login
app.post('/auth/email/send-otp', async (req, res) => {
  const { email } = req.body;
  try {
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    if (!process.env.RESEND_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Email service is not configured on server'
      });
    }

    const users = readUsers();
    let user = users.find((u) => u.email === email);
    if (!user) {
      user = { _id: crypto.randomBytes(12).toString('hex'), email, isFirstLogin: true, createdAt: new Date().toISOString() };
      users.push(user);
    }

    // Existing accounts created via password/social login may not have OTP secret yet.
    if (!user.otpSecret) {
      user.otpSecret = authenticator.generateSecret();
    }

    const idx = users.findIndex((u) => u.email === email);
    if (idx >= 0) users[idx] = user;
    writeUsers(users);

    const token = authenticator.generate(user.otpSecret);

    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Your NORDLUXE Login OTP',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to NORDLUXE</h2>
          <p>Your one-time password is: <strong>${token}</strong></p>
          <p>This code will expire in 10 minutes.</p>
        </div>
      `
    });
    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (error) {
    console.error('send-otp error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP' });
  }
});

app.post('/auth/email/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const users = readUsers();
    const user = users.find((u) => u.email === email);
    if (!user) return res.status(400).json({ success: false, message: 'User not found' });

    if (!user.otpSecret) {
      return res.status(400).json({ success: false, message: 'No OTP active for this account. Request a new OTP.' });
    }

    const isValid = authenticator.verify({ token: otp, secret: user.otpSecret });
    if (!isValid) return res.status(400).json({ success: false, message: 'Invalid OTP' });

    if (user.isFirstLogin) {
      user.isFirstLogin = false;
      const uidx = users.findIndex((u) => u.email === email);
      if (uidx >= 0) users[uidx] = user;
      writeUsers(users);
    }

    req.login(user, (err) => {
      if (err) return res.status(500).json({ success: false, message: 'Login failed' });
      res.json({ success: true, message: 'Logged in successfully' });
    });
  } catch (error) {
    console.error('verify-otp error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/index.html');
  });
});

app.get('/auth/user', (req, res) => {
  if (req.user) {
    res.json({ user: { email: req.user.email, name: req.user.name } });
  } else {
    res.json({ user: null });
  }
});

app.post('/auth/password/reset-request', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ success: false, message: 'Email service is not configured on server' });
  }

  if (!firebaseAdminAuth) {
    return res.status(503).json({ success: false, message: 'Password reset service is not configured on server' });
  }

  const normalizedEmail = normalizeText(email).toLowerCase();
  const frontendBase = normalizeText(process.env.FRONTEND_URL) || `http://localhost:${PORT}`;
  const actionCodeSettings = {
    url: `${frontendBase}/html/login.html`,
    handleCodeInApp: false
  };

  try {
    const userRecord = await firebaseAdminAuth.getUserByEmail(normalizedEmail);
    const hasPasswordProvider = (userRecord.providerData || []).some((provider) => provider.providerId === 'password');

    if (hasPasswordProvider) {
      const resetLink = await firebaseAdminAuth.generatePasswordResetLink(normalizedEmail, actionCodeSettings);

      await resend.emails.send({
        from: EMAIL_FROM,
        to: normalizedEmail,
        subject: 'NORDLUXE - Password Reset Request',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #d19b48;">Reset Your NORDLUXE Password</h2>
            <p>We received a request to reset your password.</p>
            <p style="margin: 20px 0;">
              <a href="${resetLink}" style="background: #d19b48; color: #fff; text-decoration: none; padding: 12px 18px; border-radius: 8px; display: inline-block;">Reset Password</a>
            </p>
            <p>If you did not request this, you can safely ignore this email.</p>
            <p style="color: #666; font-size: 12px;">For security reasons, this link expires automatically.</p>
          </div>
        `
      });
    }

    return res.json({
      success: true,
      message: 'If an Email/Password account exists for this email, a reset link has been sent.'
    });
  } catch (error) {
    if (error && error.code !== 'auth/user-not-found') {
      console.error('password reset request error:', error);
    }

    return res.json({
      success: true,
      message: 'If an Email/Password account exists for this email, a reset link has been sent.'
    });
  }
});

// Password-based auth routes
app.post('/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const users = readUsers();
    const existingUser = users.find((u) => u.email === email);
    if (existingUser) return res.status(400).json({ success: false, message: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = { _id: crypto.randomBytes(12).toString('hex'), email, password: hashedPassword, name, createdAt: new Date().toISOString() };
    users.push(user);
    writeUsers(users);

    req.login(user, (err) => {
      if (err) return res.status(500).json({ success: false, message: 'Signup failed' });
      res.json({ success: true, message: 'Account created successfully' });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Signup failed' });
  }
});

app.post('/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  try {
    const users = readUsers();
    const user = users.find((u) => u.email === email);
    if (!user || !user.password) return res.status(400).json({ success: false, message: 'Invalid credentials' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(400).json({ success: false, message: 'Invalid credentials' });

    req.login(user, (err) => {
      if (err) return res.status(500).json({ success: false, message: 'Login failed' });
      res.json({ success: true, message: 'Logged in successfully' });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function parseDevice(ua) {
  if (!ua) return 'Unknown';
  if (/mobile|android|iphone|ipad|ipod/i.test(ua)) return 'Mobile';
  if (/tablet/i.test(ua)) return 'Tablet';
  return 'Desktop';
}

// Public heartbeat used by storefront pages for live visitor analytics
app.post('/api/analytics/heartbeat', (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = normalizeText(body.sessionId || body.sid || '');
    const page = normalizePagePath(body.page || req.headers.referer || '/');
    const pageTitle = normalizeText(body.title || '').slice(0, 120);
    const userEmail = normalizeText(body.userEmail || '').toLowerCase().slice(0, 160);
    const userName = normalizeText(body.userName || '').slice(0, 120);
    const isLoggedIn = Boolean(body.isLoggedIn || userEmail);

    if (!sessionId || sessionId.length < 8 || sessionId.length > 120) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const existing = liveSessions.get(sessionId) || {};
    const wasLoggedIn = Boolean(existing.isLoggedIn);
    const firstSeenAt = existing.firstSeenAt || Date.now();
    const pageHistory = Array.isArray(existing.pageHistory) ? existing.pageHistory : [];
    const lastPage = pageHistory.length > 0 ? pageHistory[pageHistory.length - 1] : null;
    if (!lastPage || lastPage.page !== page) {
      pageHistory.push({ page, title: pageTitle, at: Date.now() });
      if (pageHistory.length > 30) pageHistory.shift();
    }

    liveSessions.set(sessionId, {
      page,
      pageTitle,
      firstSeenAt,
      lastSeenAt: Date.now(),
      pageHistory,
      isLoggedIn,
      userEmail,
      userName,
      userAgent: normalizeText(req.headers['user-agent'] || '').slice(0, 220)
    });

    if (!wasLoggedIn && isLoggedIn) {
      pushLiveEvent({
        at: Date.now(),
        type: 'auth-login',
        sessionId: sessionId.slice(0, 8) + '...',
        page,
        title: pageTitle,
        userEmail,
        userName
      });
    }

    cleanupLiveSessions();
    return res.json({ success: true });
  } catch (error) {
    console.error('Heartbeat analytics error:', error.message);
    return res.status(500).json({ success: false, message: 'Heartbeat failed' });
  }
});

// Public explicit session-end signal to immediately remove a visitor
app.post('/api/analytics/session-end', (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = normalizeText(body.sessionId || body.sid || '');
    const reason = normalizeText(body.reason || 'ended').slice(0, 60);

    if (!sessionId || sessionId.length < 8 || sessionId.length > 120) {
      return res.status(400).json({ success: false, message: 'Invalid session' });
    }

    const existing = liveSessions.get(sessionId);
    if (existing) {
      pushLiveEvent({
        at: Date.now(),
        type: reason === 'logout' ? 'auth-logout' : 'session-end',
        sessionId: sessionId.slice(0, 8) + '...',
        page: existing.page || '/',
        title: existing.pageTitle || '',
        userEmail: existing.userEmail || '',
        userName: existing.userName || ''
      });
    }

    liveSessions.delete(sessionId);
    cleanupLiveSessions();
    return res.json({ success: true, activeVisitors: liveSessions.size });
  } catch (error) {
    console.error('Session end analytics error:', error.message);
    return res.status(500).json({ success: false, message: 'Session end failed' });
  }
});

// Public activity event endpoint (site actions: page/search/cart/etc.)
app.post('/api/analytics/event', (req, res) => {
  try {
    const body = req.body || {};
    const sessionId = normalizeText(body.sessionId || body.sid || '');
    const type = normalizeText(body.type || '').slice(0, 50);
    const title = normalizeText(body.title || '').slice(0, 160);
    const details = normalizeText(body.details || '').slice(0, 220);
    const page = normalizePagePath(body.page || '/');
    const userEmail = normalizeText(body.userEmail || '').toLowerCase().slice(0, 160);
    const userName = normalizeText(body.userName || '').slice(0, 120);

    if (!sessionId || sessionId.length < 8 || sessionId.length > 120 || !type) {
      return res.status(400).json({ success: false, message: 'Invalid event payload' });
    }

    pushLiveEvent({
      at: Date.now(),
      type,
      title,
      details,
      page,
      userEmail,
      userName,
      sessionId: sessionId.slice(0, 8) + '...'
    });

    return res.json({ success: true });
  } catch (error) {
    console.error('Analytics event error:', error.message);
    return res.status(500).json({ success: false, message: 'Event capture failed' });
  }
});

// Admin-only live sessions (full detail per visitor)
app.get('/api/admin/live-sessions', (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    cleanupLiveSessions();
    const sessions = [];
    for (const [sessionId, entry] of liveSessions.entries()) {
      const timeOnSiteMs = Date.now() - Number(entry.firstSeenAt || Date.now());
      sessions.push({
        sessionId: sessionId.slice(0, 8) + '...',
        currentPage: entry.page || '/',
        pageTitle: entry.pageTitle || '',
        isLoggedIn: Boolean(entry.isLoggedIn),
        userEmail: entry.userEmail || '',
        userName: entry.userName || '',
        timeOnSite: formatDuration(timeOnSiteMs),
        timeOnSiteMs,
        pagesVisited: Array.isArray(entry.pageHistory) ? entry.pageHistory.length : 1,
        pageHistory: entry.pageHistory || [],
        device: parseDevice(entry.userAgent || ''),
        lastSeenAt: entry.lastSeenAt
      });
    }
    sessions.sort((a, b) => b.timeOnSiteMs - a.timeOnSiteMs);
    return res.json({ success: true, sessions, total: sessions.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Admin live-sessions error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not fetch sessions' });
  }
});

// Admin customer summary (unique customers from orders)
app.get('/api/admin/customer-summary', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const orders = await getOrdersForQuery({});
    const map = {};
    for (const order of orders) {
      const email = normalizeText(order.customerEmail || '').toLowerCase();
      if (!email) continue;
      if (!map[email]) {
        map[email] = { email, name: order.customerName || 'Unknown', orderCount: 0, totalSpend: 0, lastOrderAt: null, orders: [] };
      }
      map[email].orderCount++;
      map[email].totalSpend += Number(order.totalAmount || 0);
      const d = new Date(order.createdAt);
      if (!map[email].lastOrderAt || d > new Date(map[email].lastOrderAt)) {
        map[email].lastOrderAt = order.createdAt;
      }
      map[email].orders.push({ id: displayOrderId(order), status: order.status || 'pending', amount: order.totalAmount || 0, date: order.createdAt });
    }
    const customers = Object.values(map).sort((a, b) => b.totalSpend - a.totalSpend);
    return res.json({ success: true, customers, total: customers.length });
  } catch (error) {
    console.error('Admin customer-summary error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not fetch customers' });
  }
});

// Admin-only live analytics snapshot
app.get('/api/admin/live-analytics', (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const snapshot = buildLiveAnalyticsSnapshot();
    return res.json({ success: true, ...snapshot });
  } catch (error) {
    console.error('Admin live analytics error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not fetch analytics' });
  }
});

// Admin-only recent site activity feed
app.get('/api/admin/live-events', (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 120)));
    return res.json({
      success: true,
      events: liveEvents.slice(0, limit),
      total: liveEvents.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin live-events error:', error.message);
    return res.status(500).json({ success: false, message: 'Could not fetch events' });
  }
});

// ─── Newsletter Routes ─────────────────────────────────────────────────────

// Subscribe to newsletter
app.post('/api/newsletter/subscribe', async (req, res) => {
  try {
    const rawEmail = req.body.email;
    const rawName = req.body.name;

    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(400).json({ success: false, message: 'A valid email is required.' });
    }

    const email = rawEmail.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    const name = normalizeText(rawName).slice(0, 80);

    const subscribers = readSubscribers();
    const existing = subscribers.find((s) => s.email === email);
    if (existing) {
      if (!existing.active) {
        existing.active = true;
        const eidx = subscribers.findIndex((s) => s.email === email);
        if (eidx >= 0) subscribers[eidx] = existing;
        writeSubscribers(subscribers);
        return res.json({ success: true, message: 'Welcome back! You have been re-subscribed.' });
      }
      return res.json({ success: true, message: 'You are already subscribed.' });
    }

    subscribers.push({ email, name, subscribedAt: new Date().toISOString(), active: true });
    writeSubscribers(subscribers);

    // Welcome email to subscriber
    await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: 'Welcome to NORDLUXE — You\'re on the list',
      html: `
        <div style="font-family: Montserrat, sans-serif; max-width: 560px; margin: 0 auto; background: #fffaf2; border: 1px solid rgba(209,155,72,0.3); border-radius: 12px; overflow: hidden;">
          <div style="background: linear-gradient(135deg, #1a1208, #2c1e08); padding: 28px 32px; text-align: center;">
            <h1 style="color: #d19b48; font-size: 22px; letter-spacing: 4px; margin: 0;">NORDLUXE</h1>
          </div>
          <div style="padding: 32px;">
            <h2 style="color: #2c2016; font-size: 18px; margin-bottom: 14px;">Welcome${name ? ', ' + escapeHtml(name) : ''}</h2>
            <p style="color: #5a4429; font-size: 15px; line-height: 1.7; margin-bottom: 16px;">You're now part of an exclusive circle. Expect early access to new collections, behind-the-scenes stories, and preorder windows before they open to the public.</p>
            <p style="color: #5a4429; font-size: 14px; line-height: 1.7;">We don't flood your inbox. When we reach out, it's worth reading.</p>
            <div style="margin: 24px 0; text-align: center;">
              <a href="https://nordluxe.com" style="background: #d19b48; color: #fff; padding: 12px 28px; border-radius: 22px; text-decoration: none; font-size: 14px; font-weight: 600; letter-spacing: 0.5px;">Explore the Collection</a>
            </div>
            <hr style="border: none; border-top: 1px solid rgba(209,155,72,0.2); margin: 24px 0;">
            <p style="color: #9a7d56; font-size: 12px;">You received this because you subscribed at nordluxe.com. <a href="https://nordluxe.com/html/unsubscribe.html?email=${encodeURIComponent(email)}" style="color: #d19b48;">Unsubscribe</a> at any time.</p>
          </div>
        </div>
      `
    });

    res.json({ success: true, message: 'You\'re subscribed! Check your inbox for a welcome email.' });
  } catch (err) {
    console.error('Newsletter subscribe error:', err);
    res.status(500).json({ success: false, message: 'Could not subscribe. Please try again.' });
  }
});

// Unsubscribe from newsletter
app.post('/api/newsletter/unsubscribe', async (req, res) => {
  try {
    const rawEmail = req.body.email;
    if (!rawEmail || typeof rawEmail !== 'string') {
      return res.status(400).json({ success: false, message: 'Email required.' });
    }
    const email = rawEmail.toLowerCase().trim();
    const subscribers = readSubscribers();
    const sidx = subscribers.findIndex((s) => s.email === email);
    if (sidx >= 0) {
      subscribers[sidx].active = false;
      writeSubscribers(subscribers);
    }
    res.json({ success: true, message: 'You have been unsubscribed.' });
  } catch (err) {
    console.error('Newsletter unsubscribe error:', err);
    res.status(500).json({ success: false, message: 'Could not unsubscribe. Please try again.' });
  }
});

// Send newsletter — admin only (protect with NEWSLETTER_ADMIN_KEY in .env)
app.post('/api/newsletter/send', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }

    const { subject, html, text } = req.body;
    if (!subject || !html) {
      return res.status(400).json({ success: false, message: 'subject and html are required.' });
    }

    const allSubscribers = readSubscribers().filter((s) => s.active);
    if (!allSubscribers.length) {
      return res.json({ success: true, message: 'No active subscribers found.', sent: 0 });
    }

    let sent = 0;
    let failed = 0;

    for (const sub of allSubscribers) {
      try {
        const personalizedHtml = html
          .replace(/{{name}}/g, escapeHtml(sub.name || 'there'))
          .replace(/{{email}}/g, encodeURIComponent(sub.email));

        await resend.emails.send({
          from: EMAIL_FROM,
          to: sub.email,
          subject: subject,
          html: personalizedHtml
        });
        sent++;
      } catch (mailErr) {
        console.error('Failed to send to', sub.email, mailErr);
        failed++;
      }
    }

    res.json({
      success: true,
      message: `Newsletter sent to ${sent} subscriber(s). ${failed} failed.`,
      sent,
      failed
    });
  } catch (err) {
    console.error('Newsletter send error:', err);
    res.status(500).json({ success: false, message: 'Could not send newsletter.' });
  }
});

// ─── End Newsletter Routes ───────────────────────────────────────────────────

// ─── Order Tracking Routes ───────────────────────────────────────────────────

// Helper: Send status update email
async function sendStatusUpdateEmail(order, newStatus) {
  const statusMessages = {
    confirmed: 'Thank you for your order. Your order is now being made by our team.',
    packed: 'Your order is being prepared and packed for shipping.',
    dispatched: 'Your order has been shipped and is now on the way to you.',
    'in-transit': 'Your order is coming to you and is currently in transit.',
    delivered: 'Your order has arrived at your delivery location.',
    received: 'Your order is here and marked as completed. Thank you for shopping with NORDLUXE.'
  };

  const recipient = normalizeText(order && order.customerEmail).toLowerCase();
  if (!recipient) {
    console.error('Status email send error: Missing customer email for order', displayOrderId(order));
    return false;
  }

  const trackingInfo = order.trackingNumber ? `<p><strong>Tracking Number:</strong> ${order.trackingNumber}</p><p><strong>Shipping Company:</strong> ${order.shippingCompany || 'Standard Shipping'}</p>` : '';

  const mailOptions = {
    from: EMAIL_FROM,
    to: recipient,
    subject: `NORDLUXE Update: Order ${displayOrderId(order)} - ${newStatus.toUpperCase()}`,
    html: `
      <h2>Order Status Update</h2>
      <p>Hi ${order.customerName},</p>
      <p>${statusMessages[newStatus]}</p>
      ${trackingInfo}
      <div style="background: #f8f8f8; border-radius: 10px; padding: 16px; margin: 16px 0;">
        <h3>Order Summary</h3>
        <p><strong>Order ID:</strong> ${displayOrderId(order)}</p>
        <p><strong>Status:</strong> ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1).replace(/-/g, ' ')}</p>
        <p><strong>Total Amount:</strong> ₦${order.totalAmount.toLocaleString()}</p>
        ${order.statusHistory.length ? `<p><strong>Order Created:</strong> ${new Date(order.createdAt).toLocaleDateString()}</p>` : ''}
      </div>
      <p>If you need any assistance, please contact our support team.</p>
      <p>Best regards,<br/>NORDLUXE Team</p>
    `
  };

  try {
    await sendTransactionalEmail(mailOptions);
    return true;
  } catch (err) {
    console.error('Status email send error:', err);
    return false;
  }
}

// POST /api/orders - Create order (called after successful payment)
app.post('/api/orders', async (req, res) => {
  try {
    const { customerEmail, customerName, userId, items, totalAmount, paymentPlan, flutterwaveRef, paymentReference } = req.body;
    const normalizedCustomerEmail = extractSingleEmail(customerEmail);
    const normalizedCustomerName = normalizeText(customerName);

    if (!normalizedCustomerEmail || !normalizedCustomerName || !items || !totalAmount) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    let orderCode = generateOrderCode();
    for (let i = 0; i < 5; i++) {
      const exists = readFallbackOrders().find((x) => String(x.orderCode || '').toUpperCase() === orderCode);
      if (!exists) break;
      orderCode = generateOrderCode();
    }

    const orderPayload = {
      customerEmail: normalizedCustomerEmail,
      customerName: normalizedCustomerName,
      orderCode,
      userId: userId || null,
      items,
      totalAmount,
      paymentPlan: paymentPlan || {},
      flutterwaveRef: flutterwaveRef || null,
      paymentReference: paymentReference || null,
      status: 'pending',
      statusHistory: [{
        status: 'pending',
        timestamp: new Date(),
        notes: 'Order created'
      }],
      createdAt: new Date(),
      assignedTo: '',
      internalNotes: [],
      customerConfirmedReceived: false,
      notificationsSent: {
        confirmed: false,
        packed: false,
        dispatched: false,
        inTransit: false,
        delivered: false,
        received: false
      }
    };

    const all = readFallbackOrders();
    const order = Object.assign({ _id: crypto.randomBytes(12).toString('hex') }, orderPayload);
    all.unshift(order);
    writeFallbackOrders(all);

    // NOTE: Confirmation email is already sent via sendOrderConfirmationEmail()
    // which is triggered by payment webhook and /api/verify-payment endpoints.
    // Do NOT send a second confirmation here to avoid duplicate emails.

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false, message: 'Could not create order' });
  }
});

// GET /api/orders - Get all orders (admin only)
app.get('/api/orders', async (req, res) => {
  try {
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const orders = await getOrdersForQuery({});
    res.json({ success: true, orders });
  } catch (err) {
    console.error('Orders fetch error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch orders' });
  }
});

async function findOrderByFlexibleId(orderId) {
  if (!orderId) return null;

  const raw = decodeURIComponent(String(orderId)).trim().replace(/^#/, '');
  if (!raw) return null;

  const normalized = raw.replace(/\s+/g, '').replace(/[^A-Za-z0-9-]/g, '');
  const upper = normalized.toUpperCase();
  if (!upper) return null;

  const fallbackAll = readFallbackOrders();

  const byPaymentRef = fallbackAll.find((x) => {
    const pref = String(x.paymentReference || '');
    const fref = String(x.flutterwaveRef || '');
    return pref === normalized || pref.toUpperCase() === upper || fref === normalized || fref.toUpperCase() === upper;
  });
  if (byPaymentRef) return byPaymentRef;

  if (/^NLX-[A-Z0-9]{8}$/.test(upper)) {
    const byExactCode = fallbackAll.find((x) => String(x.orderCode || '').toUpperCase() === upper);
    if (byExactCode) return byExactCode;
  }

  if (/^[A-Z0-9]{8}$/.test(upper)) {
    const byShortCode = fallbackAll.find((x) => String(x.orderCode || '').toUpperCase() === `NLX-${upper}`);
    if (byShortCode) return byShortCode;
  }

  const codeCandidate = upper.startsWith('NLX-') ? upper : `NLX-${upper}`;
  const byOrderCode = fallbackAll.find((x) => String(x.orderCode || '').toUpperCase() === codeCandidate);
  if (byOrderCode) return byOrderCode;

  if (/^NLX-[A-Z0-9]{8}$/.test(upper)) {
    const bareShort = upper.replace(/^NLX-/, '');
    const recentOrders = sortByCreatedDesc(fallbackAll).slice(0, 5000);
    const byLegacyShort = recentOrders.find((item) => item._id.toString().slice(-8).toUpperCase() === bareShort);
    if (byLegacyShort) return byLegacyShort;
  }

  if (/^[a-fA-F0-9]{24}$/.test(normalized)) {
    const byRawId = fallbackAll.find((x) => String(x._id || '') === normalized);
    if (byRawId) return byRawId;
  }

  const recentOrders = sortByCreatedDesc(fallbackAll).slice(0, 5000);
  return recentOrders.find((item) => item._id.toString().slice(-8).toUpperCase() === upper) || null;
}

// GET /api/orders/:orderId - Get order details
app.get('/api/orders/:orderId', async (req, res) => {
  try {
    const order = await findOrderByFlexibleId(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    res.json({ success: true, order });
  } catch (err) {
    console.error('Order fetch error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch order' });
  }
});

// GET /api/users/:userId/orders - Get all orders for a user
app.get('/api/users/:userId/orders', async (req, res) => {
  try {
    let query = {};
    
    // Support both userId path parameter and email query parameter
    if (req.params.userId === 'guest' && req.query.email) {
      const email = String(req.query.email || '').trim();
      query = { customerEmail: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
    } else {
      query = { 
        $or: [
          { userId: req.params.userId },
          { customerEmail: new RegExp(`^${String(req.query.email || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        ]
      };
    }
    
    const orders = await getOrdersForQuery(query);
    
    res.json({ success: true, orders });
  } catch (err) {
    console.error('User orders fetch error:', err);
    res.status(500).json({ success: false, message: 'Could not fetch orders' });
  }
});

// PUT /api/orders/:orderId/status - Update order status (admin only)
app.put('/api/orders/:orderId/status', async (req, res) => {
  try {
    const { status, trackingNumber, trackingUrl, shippingCompany, notes, updatedBy, internalNote } = req.body;

    // Verify admin key
    if (req.headers['x-admin-key'] !== process.env.NEWSLETTER_ADMIN_KEY) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const validStatuses = ['pending', 'confirmed', 'packed', 'dispatched', 'in-transit', 'delivered', 'received'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    let order = await findOrderByFlexibleId(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Update status
    order.status = status;
    const actor = normalizeText(updatedBy);
    const customerNotes = normalizeText(notes);
    const notePrefix = actor ? `Updated by ${actor}` : '';
    const historyNotes = [customerNotes, notePrefix].filter(Boolean).join(' | ');

    order.statusHistory.push({
      status: status,
      timestamp: new Date(),
      notes: historyNotes || customerNotes || ''
    });

    if (actor) {
      order.assignedTo = actor;
    }

    const safeInternalNote = normalizeText(internalNote);
    if (safeInternalNote) {
      if (!Array.isArray(order.internalNotes)) order.internalNotes = [];
      order.internalNotes.push({
        note: safeInternalNote,
        by: actor || 'Admin',
        at: new Date()
      });
    }

    // Update timestamp fields based on status
    if (status === 'confirmed' && !order.confirmedAt) order.confirmedAt = new Date();
    if (status === 'packed' && !order.packedAt) order.packedAt = new Date();
    if (status === 'dispatched' && !order.dispatchedAt) order.dispatchedAt = new Date();
    if (status === 'in-transit') {
      order.trackingNumber = trackingNumber || order.trackingNumber;
      order.trackingUrl = trackingUrl || order.trackingUrl;
      order.shippingCompany = shippingCompany || order.shippingCompany;
    }
    if (status === 'delivered' && !order.deliveredAt) order.deliveredAt = new Date();

    const list = readFallbackOrders();
    const idx = list.findIndex((x) => String(x._id) === String(order._id));
    if (idx >= 0) {
      list[idx] = order;
      writeFallbackOrders(list);
    }

    // Send status update email
    const notificationKeyByStatus = {
      confirmed: 'confirmed',
      packed: 'packed',
      dispatched: 'dispatched',
      'in-transit': 'inTransit',
      delivered: 'delivered',
      received: 'received'
    };
    const notificationKey = notificationKeyByStatus[status];

    if (!order.notificationsSent || typeof order.notificationsSent !== 'object') {
      order.notificationsSent = {
        confirmed: false,
        packed: false,
        dispatched: false,
        inTransit: false,
        delivered: false,
        received: false
      };
    }

    let emailSent = true;
    if (notificationKey && !order.notificationsSent[notificationKey]) {
      emailSent = await sendStatusUpdateEmail(order, status);
      if (emailSent) {
        order.notificationsSent[notificationKey] = true;
        const notifList = readFallbackOrders();
        const notifIdx = notifList.findIndex((x) => String(x._id) === String(order._id));
        if (notifIdx >= 0) {
          notifList[notifIdx] = order;
          writeFallbackOrders(notifList);
        }
      }
    }

    res.json({
      success: true,
      order,
      message: emailSent
        ? `Order status updated to ${status}`
        : `Order status updated to ${status}, but email delivery failed`
    });
  } catch (err) {
    console.error('Order status update error:', err);
    res.status(500).json({ success: false, message: 'Could not update order status' });
  }
});

// ─── Preorder Dashboard Routes ───────────────────────────────────────────────

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({ success: true, message: 'Test endpoint works' });
});

// Get preorder details for dashboard
app.post('/api/preorder-dashboard', (req, res) => {
  const { orderId, email } = req.body;

  if (!orderId || !email) {
    return res.status(400).json({
      success: false,
      message: 'Order ID and email are required'
    });
  }

  try {
    const orders = readFallbackOrders();
    const normalizedEmail = normalizeText(email);

    // Find the customer's order (each customer has only one order now)
    const customerOrder = orders.find(o =>
      normalizeText(o.customerEmail || '') === normalizedEmail
    );

    if (!customerOrder) {
      return res.status(404).json({
        success: false,
        message: 'No order found for this email address.'
      });
    }

    res.json({
      success: true,
      masterOrderId: customerOrder.flutterwaveRef,
      order: {
        flutterwaveRef: customerOrder.flutterwaveRef,
        customerEmail: customerOrder.customerEmail,
        customerName: customerOrder.customerName,
        items: customerOrder.items.map(item => ({
          itemName: item.name || item.itemName,
          quantity: item.quantity || 1,
          unitPrice: item.finalPrice || item.price || 0
        })),
        totalAmount: customerOrder.totalAmount,
        currency: customerOrder.currency || 'NGN',
        createdAt: customerOrder.createdAt,
        status: customerOrder.status || 'pending'
      }
    });
  } catch (error) {
    console.error('Preorder dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve order details'
    });
  }
});

// Initiate remaining balance payment (60%)
app.post('/api/initiate-remaining-payment', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      message: 'Order ID is required'
    });
  }

  try {
    const orders = readFallbackOrders();
    const normalizedOrderId = normalizeText(orderId);
    const order = orders.find(o => normalizeText(o.flutterwaveRef || '') === normalizedOrderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const remainingAmount = Math.round(order.totalAmount * 0.6 * 100) / 100;
    const txRef = `nordluxe-balance-${orderId}-${Date.now()}`;

    const flutterwavePayload = {
      tx_ref: txRef,
      amount: remainingAmount,
      currency: order.currency || 'NGN',
      payment_options: 'card,bank,ussd',
      redirect_url: `${process.env.FRONTEND_URL || 'http://localhost:8000'}/payment-success.html`,
      customer: {
        email: order.customerEmail,
        name: order.customerName,
        phone: order.customerPhone || ''
      },
      meta: {
        orderId: orderId,
        paymentType: 'preorder-final',
        originalOrderTotal: order.totalAmount,
        finalPaymentAmount: remainingAmount
      }
    };

    // Initialize with Flutterwave
    const fw = new Flutterwave(process.env.FLUTTERWAVE_PUBLIC_KEY, process.env.FLUTTERWAVE_SECRET_KEY);
    const response = await fw.Charge.card(flutterwavePayload);

    if (response.status === 'success' && response.data.link) {
      res.json({
        success: true,
        paymentLink: response.data.link,
        txRef: txRef
      });
    } else {
      throw new Error('Failed to generate payment link');
    }
  } catch (error) {
    console.error('Remaining payment initiation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate payment. Please try again.'
    });
  }
});

// ─── End Preorder Dashboard Routes ───────────────────────────────────────────

// ─── End Order Tracking Routes ───────────────────────────────────────────────

// Start server

module.exports = app;