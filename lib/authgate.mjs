// Optional shared-password gate for public deployments.
// Enabled only when CRUCIX_PASSWORD is set; local runs without it are untouched.

import express from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const COOKIE = 'crucix_auth';
const SESSION_HOURS = parseInt(process.env.CRUCIX_SESSION_HOURS) || 24 * 7;
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/api/health', '/favicon.ico']);

const failures = new Map(); // ip -> { count, until }

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeToken(secret) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${exp}.${randomBytes(8).toString('hex')}`;
  return `${payload}.${sign(secret, payload)}`;
}

function verifyToken(secret, token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!safeEqual(sig, sign(secret, payload))) return false;
  const exp = parseInt(payload.split('.')[0]);
  return Number.isFinite(exp) && exp > Date.now();
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}

function isLocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.until && f.until > Date.now()) return true;
  if (f.until) failures.delete(ip);
  return false;
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCKOUT_MS; f.count = 0; }
  failures.set(ip, f);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'authentication_failure', ip, locked: !!f.until }));
}

function loginPage(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CRUCIX — Access</title>
<style>
  html,body{height:100%;margin:0;background:#050a0f;color:#c8f0ff;font-family:"JetBrains Mono","Fira Code",Consolas,monospace}
  body{display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#0a1a26 0%,#050a0f 70%)}
  form{width:320px;padding:32px 28px;border:1px solid #1f4a5f;background:rgba(6,18,26,.92);box-shadow:0 0 40px rgba(0,180,255,.12)}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:.35em;color:#4fd8ff}
  p{margin:0 0 20px;font-size:11px;color:#6fa3b8;letter-spacing:.12em}
  input{width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:14px;background:#08141c;border:1px solid #1f4a5f;color:#c8f0ff;font:inherit;font-size:14px;outline:none}
  input:focus{border-color:#4fd8ff}
  button{width:100%;padding:10px;background:#0e3a4d;border:1px solid #4fd8ff;color:#e6fbff;font:inherit;font-size:13px;letter-spacing:.2em;cursor:pointer}
  button:hover{background:#155a75}
  .err{color:#ff6b6b;font-size:12px;margin:-6px 0 12px}
  footer{margin-top:18px;font-size:10px;letter-spacing:.1em;color:#4a7a8c;text-align:center}
  footer b{color:#3969CA;font-weight:600}
</style></head><body>
<form method="post" action="/login" autocomplete="off">
  <h1>CRUCIX</h1>
  <p>INTELLIGENCE ENGINE // RESTRICTED</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="password" name="password" placeholder="Access code" required autofocus maxlength="255">
  <button type="submit">ENTER</button>
  <footer>Hosted by <b>Cognition AI</b></footer>
</form></body></html>`;
}

export function installAuthGate(app) {
  const password = process.env.CRUCIX_PASSWORD;
  if (!password) return false;

  const secret = process.env.CRUCIX_SESSION_SECRET || randomBytes(32).toString('hex');
  const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

  app.get('/login', (req, res) => {
    if (verifyToken(secret, parseCookies(req.headers.cookie)[COOKIE])) return res.redirect('/');
    res.type('html').send(loginPage());
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const ip = clientIp(req);
    if (isLocked(ip)) return res.status(429).type('html').send(loginPage('Too many attempts. Try again in 15 minutes.'));

    const attempt = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!attempt || attempt.length > 255 || !safeEqual(attempt, password)) {
      recordFailure(ip);
      return res.status(401).type('html').send(loginPage('Invalid access code.'));
    }

    const cookie = [
      `${COOKIE}=${makeToken(secret)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${SESSION_HOURS * 3600}`,
      isHttps(req) ? 'Secure' : '',
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'authentication_success', ip }));
    res.redirect('/');
  });

  app.use((req, res, next) => {
    req.authenticated = verifyToken(secret, parseCookies(req.headers.cookie)[COOKIE]);
    if (req.authenticated || PUBLIC_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect('/login');
    res.status(401).json({ error: 'Unauthorized' });
  });

  return true;
}
