// Vercel serverless function: receives Assets 10 webhooks for new/updated assets,
// checks for duplicates (same checksum and/or same capture date + time) and
//   1. writes a flag + list of matches into custom metadata fields on the new asset,
//   2. optionally sends an e-mail and/or a chat message to the image desk.
//
// Endpoint: POST /api/webhook  (configure this URL as webhook in the Management Console)
//
// Env-vars (Vercel > Project > Settings > Environment Variables):
//   ASSETS_API_BASE        region endpoint, e.g. https://api-eu-west-1.swivle.com
//   ASSETS_API_KEY         Assets API key (Management Console > API)
//   WEBHOOK_SECRET         secret token of the webhook (Management Console > Webhooks)
//
//   CHECKSUM_FIELD         default firstExtractedChecksum
//   CAPTURE_DATE_FIELD     default created            (VERIFY in your schema)
//   MATCH_CAPTURE_DATE     default true
//   FLAG_FIELD             default cf_duplicateCheck  (custom field, text)
//   MATCHES_FIELD          default cf_possibleDuplicateOf (custom field, text, multi-value)
//   WRITE_METADATA         default true
//   UPDATE_ENDPOINT        default /services/update   (VERIFY, see README)
//
//   IGNORE_CREATORS        comma-separated user names to skip (service accounts, imports)
//   ONLY_FOLDERS           comma-separated folder prefixes to check (empty = all)
//   IGNORE_FOLDERS         comma-separated folder prefixes to skip
//
//   RESEND_API_KEY, MAIL_FROM, MAIL_TO   optional e-mail via resend.com
//   CHAT_WEBHOOK_URL       optional Slack-compatible incoming webhook ({ text })
//   ASSET_LINK_TEMPLATE    optional, e.g. https://acme.woodwing.cloud/#/asset/{id}

const crypto = require('crypto');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const list = k => env(k, '').split(',').map(s => s.trim()).filter(Boolean);
const bool = (k, d) => String(env(k, d)).toLowerCase() === 'true';

const CFG = {
  base: env('ASSETS_API_BASE', '').trim().replace(/\/+$/, ''),
  checksumField: env('CHECKSUM_FIELD', 'firstExtractedChecksum'),
  dateField: env('CAPTURE_DATE_FIELD', 'created'),
  matchDate: bool('MATCH_CAPTURE_DATE', 'true'),
  flagField: env('FLAG_FIELD', 'cf_duplicateCheck'),
  matchesField: env('MATCHES_FIELD', 'cf_possibleDuplicateOf'),
  writeMetadata: bool('WRITE_METADATA', 'true'),
  updateEndpoint: env('UPDATE_ENDPOINT', '/services/update'),
  ignoreCreators: list('IGNORE_CREATORS').map(s => s.toLowerCase()),
  onlyFolders: list('ONLY_FOLDERS'),
  ignoreFolders: list('IGNORE_FOLDERS'),
};

const FLAG_POSSIBLE = 'Possible duplicate';
const FLAG_CLEAN = 'No duplicates found';

// ---------- helpers ----------
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function validSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const expected = crypto.createHmac('sha256', secret.trim()).update(raw).digest('hex');
  // Accept "abc…", "sha256=abc…" and upper case.
  const got = String(header).trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Diagnostics for a failed signature check. Never logs the secret or full signatures.
function logSignatureDebug(req, raw) {
  const sig = String(req.headers['x-hook-signature'] || '');
  const secret = String(process.env.WEBHOOK_SECRET || '');
  console.log('[sig-debug]', JSON.stringify({
    headerPresent: !!sig,
    headerLength: sig.length,
    headerStart: sig.slice(0, 6),
    sigHeaders: Object.keys(req.headers).filter(h => /sign|hook|hmac/i.test(h)),
    rawBodyLength: raw.length,
    contentType: req.headers['content-type'] || null,
    secretLength: secret.length,
    secretHasWhitespace: secret !== secret.trim(),
  }));
}

const qEsc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const raw = v => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) ? v.value : v;
function toDate(v) {
  v = raw(v);
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return isNaN(d) ? null : d;
}
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const sameSecond = (a, b) => a && b && Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
const hasTime = d => d && (d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds()) !== 0;
const startsWithAny = (path, prefixes) => prefixes.some(p => String(path || '').startsWith(p));

// Assets 10 payload: { id: <event id>, time, type: 'asset.metadata-extracted', data: { asset: { id, metadata } } }
// Note: top-level `id` is the EVENT id, not the asset id.
function pickAssetId(body) {
  return body?.data?.asset?.id || body?.data?.assetId || body?.assetId || body?.asset?.id || null;
}

// ---------- Assets API ----------
let tokenCache = null; // reused while the function instance is warm

async function login(force = false) {
  if (tokenCache && !force) return tokenCache;
  const r = await fetch(CFG.base + '/auth/api-key-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: String(process.env.ASSETS_API_KEY || '').trim() }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Assets login failed (HTTP ' + r.status + '): ' + text.slice(0, 300));
  let j = {};
  try { j = JSON.parse(text); } catch (_) { throw new Error('Login response is not JSON: ' + text.slice(0, 300)); }
  if (!j.authToken) throw new Error('Login returned no authToken, check ASSETS_API_BASE and the API key');
  tokenCache = j.authToken;
  return tokenCache;
}

async function api(path, init = {}) {
  let token = await login();
  const go = t => fetch(CFG.base + path, { ...init, headers: { ...(init.headers || {}), Authorization: 'Bearer ' + t } });
  let r = await go(token);
  if (r.status === 401) { token = await login(true); r = await go(token); }
  return r;
}

async function search(q, size = 50) {
  const params = new URLSearchParams({ q, types: 'Asset', size: String(size) });
  const r = await api('/api/search?' + params.toString());
  if (!r.ok) throw new Error('Search failed (HTTP ' + r.status + '): ' + q + ' :: ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  return j.hits || [];
}

async function updateMetadata(assetId, metadata) {
  // Elvis-compatible update call. VERIFY on Assets 10 (see README).
  const form = new URLSearchParams({ id: assetId, metadata: JSON.stringify(metadata) });
  const r = await api(CFG.updateEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!r.ok) throw new Error('Metadata update failed (HTTP ' + r.status + ') via ' + CFG.updateEndpoint + ' :: ' + (await r.text()).slice(0, 300));
}

// ---------- duplicate check ----------
async function findDuplicates(asset) {
  const m = asset.metadata || {};
  const found = new Map();
  const add = (hit, reason) => {
    if (!hit || hit.id === asset.id) return;
    const e = found.get(hit.id) || { hit, reasons: new Set() };
    e.reasons.add(reason);
    found.set(hit.id, e);
  };

  const checksum = raw(m[CFG.checksumField]);
  if (checksum) {
    (await search(`${CFG.checksumField}:"${qEsc(checksum)}"`)).forEach(h => add(h, 'identical file'));
  }

  const captured = CFG.matchDate ? toDate(m[CFG.dateField]) : null;
  if (captured && hasTime(captured)) {
    const q = `${CFG.dateField}:[${ymd(addDays(captured, -1))} TO ${ymd(addDays(captured, 1))}]`;
    (await search(q, 200))
      .filter(h => sameSecond(toDate(h.metadata?.[CFG.dateField]), captured))
      .forEach(h => add(h, 'same capture time'));
  }
  return { checksum, captured, matches: [...found.values()] };
}

// ---------- notifications ----------
const fileName = h => h?.metadata?.filename || h?.metadata?.name || h?.id;
const folderOf = h => h?.metadata?.folderPath || '';
const link = id => (env('ASSET_LINK_TEMPLATE', '') ? env('ASSET_LINK_TEMPLATE', '').replace('{id}', id) : '');

function buildMessage(asset, matches) {
  const lines = [
    `Possible duplicate uploaded: ${fileName(asset)}`,
    `Folder: ${folderOf(asset)}${asset.metadata?.assetCreator ? `  (by ${asset.metadata.assetCreator})` : ''}`,
  ];
  if (link(asset.id)) lines.push(link(asset.id));
  lines.push('', 'Already in Assets:');
  matches.forEach(({ hit, reasons }) =>
    lines.push(`- ${fileName(hit)} in ${folderOf(hit)} (${[...reasons].join(', ')})${link(hit.id) ? ' ' + link(hit.id) : ''}`));
  return lines.join('\n');
}

async function notify(asset, matches) {
  const text = buildMessage(asset, matches);
  const jobs = [];
  if (process.env.RESEND_API_KEY && process.env.MAIL_TO && process.env.MAIL_FROM) {
    jobs.push(fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: list('MAIL_TO'),
        subject: `Possible duplicate: ${fileName(asset)}`,
        text,
      }),
    }));
  }
  if (process.env.CHAT_WEBHOOK_URL) {
    jobs.push(fetch(process.env.CHAT_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    }));
  }
  const results = await Promise.allSettled(jobs);
  return results.map(r => r.status === 'fulfilled' ? r.value.status : String(r.reason));
}

// ---------- handler ----------
module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'duplicate-check webhook' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const missing = ['ASSETS_API_BASE', 'ASSETS_API_KEY', 'WEBHOOK_SECRET'].filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Missing env vars: ' + missing.join(', ') });

  const rawBody = await readRaw(req);
  if (!validSignature(rawBody, req.headers['x-hook-signature'], process.env.WEBHOOK_SECRET)) {
    logSignatureDebug(req, rawBody);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let body = {};
  try { body = JSON.parse(rawBody.toString('utf8') || '{}'); } catch (_) { /* keep empty */ }
  const assetId = pickAssetId(body);
  if (!assetId) return res.status(200).json({ skipped: 'no asset id in payload', type: body?.type || null });

  try {
    // Always read the current state; the payload may not carry all fields.
    const asset = (await search(`id:"${qEsc(assetId)}"`, 1))[0];
    if (!asset) return res.status(200).json({ skipped: 'asset not found', assetId });
    const m = asset.metadata || {};

    // Already handled (this also stops the loop caused by our own metadata update).
    if (raw(m[CFG.flagField])) return res.status(200).json({ skipped: 'already checked', assetId });

    // Manual uploads only.
    const creator = String(m.assetCreator || '').toLowerCase();
    if (creator && CFG.ignoreCreators.includes(creator)) return res.status(200).json({ skipped: 'ignored creator', assetId });
    if (CFG.onlyFolders.length && !startsWithAny(m.folderPath, CFG.onlyFolders)) return res.status(200).json({ skipped: 'folder not in scope', assetId });
    if (startsWithAny(m.folderPath, CFG.ignoreFolders)) return res.status(200).json({ skipped: 'ignored folder', assetId });

    // Checksum may not be extracted yet on the first event; a later update event will retry.
    if (!raw(m[CFG.checksumField]) && !(CFG.matchDate && toDate(m[CFG.dateField]))) {
      return res.status(200).json({ skipped: 'no checksum or capture date yet', assetId });
    }

    const { matches } = await findDuplicates(asset);

    if (CFG.writeMetadata) {
      const md = { [CFG.flagField]: matches.length ? FLAG_POSSIBLE : FLAG_CLEAN };
      if (matches.length) {
        md[CFG.matchesField] = matches.map(({ hit, reasons }) => `${folderOf(hit)}/${fileName(hit)} [${[...reasons].join(', ')}] (${hit.id})`);
      }
      await updateMetadata(asset.id, md);
    }

    const notified = matches.length ? await notify(asset, matches) : [];
    return res.status(200).json({ assetId, duplicates: matches.length, notified });
  } catch (e) {
    console.error('[duplicate-check]', assetId, String(e?.message || e));
    // 5xx makes Assets retry (max 3 attempts); the flag field keeps retries idempotent.
    return res.status(502).json({ error: String(e?.message || e), assetId });
  }
};
