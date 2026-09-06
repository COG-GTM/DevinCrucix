// Security headers applied to every response, independent of whether the password gate is enabled.
// Register this middleware first in server.mjs so static files, /login and error responses all carry it.

// Origins the dashboard (dashboard/public/jarvis.html, loading.html) loads at runtime.
// 'unsafe-inline' for scripts is an accepted interim: the dashboard is a single inline-script page
// (vendoring / nonces are a Phase B item).
const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com', 'https://d3js.org', 'https://unpkg.com'];
const STYLE_HOSTS = ['https://fonts.googleapis.com'];
const FONT_HOSTS = ['https://fonts.gstatic.com'];
const CONNECT_HOSTS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://deepstatemap.live'];

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${SCRIPT_HOSTS.join(' ')}`,
  `style-src 'self' 'unsafe-inline' ${STYLE_HOSTS.join(' ')}`,
  "img-src 'self' data: blob: https:",
  `connect-src 'self' ${CONNECT_HOSTS.join(' ')}`,
  `font-src 'self' data: ${FONT_HOSTS.join(' ')}`,
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export const PERMISSIONS_POLICY = 'geolocation=(), camera=(), microphone=()';
export const HSTS = 'max-age=31536000; includeSubDomains';

const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', HSTS);
    next();
  };
}
