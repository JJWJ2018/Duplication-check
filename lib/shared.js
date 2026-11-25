// Shared helpers for the Pixometry plugin backend (Vercel serverless functions).
// Secrets live in env-vars and never reach the browser.
//
// Env-vars (Vercel > Project > Settings > Environment Variables):
//   ASSETS_API_BASE     region endpoint, e.g. https://api-eu-west-1.swivle.com
//   ASSETS_API_KEY      Assets API key (Management Console > API)
//   PIXOMETRY_API_KEY   Pixometry API key (app.pixometry.com > API Keys)
//   PIXOMETRY_API_BASE  optional, default https://app.pixometry.com
//   PLUGIN_SECRET       optional shared secret; must match PLUGIN_SECRET in config.js
//   ALLOWED_CHANNELS    optional, comma-separated channel names the plugin may use
//                       (empty = every channel in the Pixometry account)
//   NEW_FILE_SUFFIX     optional, default _pixometry. Added to the file name when the
//                       result is saved as a new file (photo.jpg -> photo_pixometry.png)

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? String(process.env[k]).trim() : d);

const CFG = {
  assetsBase: () => env('ASSETS_API_BASE', '').replace(/\/+$/, ''),
  pixBase: () => env('PIXOMETRY_API_BASE', 'https://app.pixometry.com').replace(/\/+$/, ''),
  allowedChannels: () => env('ALLOWED_CHANNELS', '').split(',').map(s => s.trim()).filter(Boolean),
};

function missingEnv() {
  return ['ASSETS_API_BASE', 'ASSETS_API_KEY', 'PIXOMETRY_API_KEY'].filter(k => !env(k, ''));
}

// Returns true when the request may continue. Sends the error response itself otherwise.
function guard(req, res, method) {
  if (req.method !== method) { res.status(405).json({ error: method + ' only' }); return false; }
  const missing = missingEnv();
  if (missing.length) { res.status(500).json({ error: 'Missing env-vars: ' + missing.join(', ') }); return false; }
  const secret = env('PLUGIN_SECRET', '');
  if (secret && String(req.headers['x-plugin-secret'] || '') !== secret) {
    res.status(401).json({ error: 'Wrong or missing plugin secret' }); return false;
  }
  return true;
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  return body || {};
}

// ---------- Assets 10 ----------
let tokenCache = null; // reused while the function instance is warm

async function assetsLogin(force = false) {
  if (tokenCache && !force) return tokenCache;
  const r = await fetch(CFG.assetsBase() + '/auth/api-key-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: env('ASSETS_API_KEY', '') }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Assets login failed (HTTP ' + r.status + '): ' + text.slice(0, 200));
  let j = {};
  try { j = JSON.parse(text); } catch (_) { throw new Error('Assets login response is not JSON'); }
  if (!j.authToken) throw new Error('Assets login returned no authToken, check ASSETS_API_BASE (region endpoint) and the API key');
  tokenCache = j.authToken;
  return tokenCache;
}

async function assetsApi(path, init = {}) {
  let token = await assetsLogin();
  const go = t => fetch(CFG.assetsBase() + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + t } });
  let r = await go(token);
  if (r.status === 401) { token = await assetsLogin(true); r = await go(token); }
  return r;
}

// ---------- Pixometry ----------
function pixApi(path, init = {}) {
  return fetch(CFG.pixBase() + path, {
    ...init,
    headers: { ...(init.headers || {}), 'X-Api-Key': env('PIXOMETRY_API_KEY', '') },
  });
}

async function pixChannels() {
  const r = await pixApi('/api/v1/channels');
  const text = await r.text();
  if (!r.ok) throw new Error('Pixometry channels failed (HTTP ' + r.status + '): ' + text.slice(0, 200));
  let list = [];
  try { list = JSON.parse(text); } catch (_) { throw new Error('Pixometry channels response is not JSON'); }
  if (!Array.isArray(list)) list = list.channels || list.items || [];
  const allowed = CFG.allowedChannels();
  return list
    .filter(c => c && c.name && (!allowed.length || allowed.includes(c.name)))
    .map(c => ({ id: c.id, name: c.name, credits: c.creditsPerImage, masking: !!c.hasMasking, upscaling: !!c.hasUpscaling }));
}

const extOf = name => { const m = /\.([A-Za-z0-9]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
const sameType = (a, b) => { const n = e => (e === 'jpeg' ? 'jpg' : e === 'tiff' ? 'tif' : e); return n(a) === n(b); };

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/tiff': 'tif',
  'image/gif': 'gif', 'application/pdf': 'pdf', 'image/vnd.adobe.photoshop': 'psd',
};

module.exports = { env, CFG, guard, readBody, assetsApi, pixApi, pixChannels, extOf, sameType, MIME_EXT };
