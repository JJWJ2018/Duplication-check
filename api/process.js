// POST /api/process   body: { assetId, filename, channel, overrides? }
// Downloads the original from Assets 10 and submits it to a Pixometry channel.
// Returns { jobId }. The panel then polls /api/status until the job is done.

const { guard, readBody, assetsApi, pixApi, pixChannels } = require('../lib/shared');

module.exports = async (req, res) => {
  if (!guard(req, res, 'POST')) return;

  const body = readBody(req);
  const assetId = String(body.assetId || '').trim();
  const channel = String(body.channel || '').trim();
  const filename = String(body.filename || '').trim() || (assetId + '.jpg');
  if (!assetId || !channel) return res.status(400).json({ error: 'assetId and channel are required' });

  // Each step gets its own time limit, so a slow system gives a clear message
  // instead of a bare timeout (HTTP 504) after 60 seconds.
  const t0 = Date.now();
  let stepName = 'start';
  const step = async (name, ms, fn) => {
    stepName = name;
    const started = Date.now();
    try { return await fn(AbortSignal.timeout(ms)); }
    finally { console.log('[process] ' + name + ': ' + (Date.now() - started) + ' ms (asset ' + assetId + ')'); }
  };

  try {
    // Only channels that exist in the account (and are allowed) can be used.
    const channels = await step('read the channel list from Pixometry', 8000, () => pixChannels());
    if (!channels.some(c => c.name === channel)) {
      return res.status(400).json({ error: 'Channel "' + channel + '" is not available' });
    }

    // 1. Download the original from Assets 10.
    const { bytes, type } = await step('download the original from Assets', 25000, async (signal) => {
      const dl = await assetsApi('/api/asset/' + encodeURIComponent(assetId) + '/original', { signal });
      if (!dl.ok) throw new Error('Download from Assets failed (HTTP ' + dl.status + ')');
      return { bytes: await dl.arrayBuffer(), type: dl.headers.get('content-type') || 'application/octet-stream' };
    });

    // 2. Submit to Pixometry.
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), filename);
    form.append('channel', channel);
    // Optional per-job settings (Pixometry "overrides"), e.g. another output file type.
    if (body.overrides && typeof body.overrides === 'object' && Object.keys(body.overrides).length) {
      form.append('overrides', JSON.stringify(body.overrides));
    }
    const { up, text } = await step('send the image to Pixometry', 25000, async (signal) => {
      const r = await pixApi('/api/v1/process', { method: 'POST', body: form, signal });
      return { up: r, text: await r.text() };
    });
    if (!up.ok) throw new Error('Pixometry refused the image (HTTP ' + up.status + '): ' + text.slice(0, 300));
    let j = {};
    try { j = JSON.parse(text); } catch (_) { throw new Error('Pixometry response is not JSON: ' + text.slice(0, 200)); }

    const jobId = j.id ?? j.jobId ?? j.job_id ?? (j.job && j.job.id);
    if (jobId === undefined || jobId === null) {
      throw new Error('Pixometry gave no job id. Response: ' + text.slice(0, 300));
    }
    return res.status(200).json({ jobId: String(jobId), sizeBytes: bytes.byteLength });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = timedOut
      ? 'No answer in time at step "' + stepName + '" (after ' + Math.round((Date.now() - t0) / 1000) + ' s in total).'
      : String((e && e.message) || e);
    console.log('[process] failed at "' + stepName + '": ' + msg);
    return res.status(timedOut ? 504 : 502).json({ error: msg, step: stepName });
  }
};
