// POST /api/status   body: { jobId, assetId, filename, saveAsNew?, suffix? }
// Checks the Pixometry job. When it is finished, downloads the result and saves it
// in Assets 10:
//   - same file type as the original  -> NEW VERSION of the same asset (previous version kept)
//   - different file type (e.g. PNG cut-out of a JPEG) -> NEW FILE next to the original
//
// Returns { state: 'processing' | 'done' | 'failed', ... }

const { env, guard, readBody, assetsApi, pixApi, extOf, sameType, MIME_EXT } = require('../lib/shared');

// Pixometry answers GET /api/v1/jobs/{id} with
//   { id, filename, submittedAt, results: [ { id, channel, status, error, ... } ] }
// (seen 16 Nov 2026: status "completed"). The status sits in results[0], not at the
// top level. Other shapes are still accepted, in case the API changes.
function jobState(j) {
  const first = Array.isArray(j.results) ? (j.results[0] || {}) : (j.results && typeof j.results === 'object' ? j.results : {});
  const raw = String(first.status ?? first.state ?? j.status ?? j.state ?? j.jobStatus ?? '').toLowerCase();
  const error = first.error || j.error || j.message || '';
  if (/fail|error|cancel|reject|bad/.test(raw)) return { state: 'failed', raw, error };
  if (/complete|done|finish|success|ready|processed/.test(raw)) return { state: 'done', raw, error };
  return { state: 'processing', raw, error };
}

function filenameFromDisposition(h) {
  if (!h) return '';
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(h);
  if (star) { try { return decodeURIComponent(star[1].replace(/"/g, '')); } catch (_) { /* fall through */ } }
  const plain = /filename="?([^";]+)"?/i.exec(h);
  return plain ? plain[1] : '';
}

module.exports = async (req, res) => {
  if (!guard(req, res, 'POST')) return;

  const body = readBody(req);
  const jobId = String(body.jobId || '').trim();
  const assetId = String(body.assetId || '').trim();
  const filename = String(body.filename || '').trim();
  const forceNew = body.saveAsNew === true; // channel is configured to always save a new file
  if (!jobId || !assetId) return res.status(400).json({ error: 'jobId and assetId are required' });

  try {
    // 1. Ask Pixometry how the job is doing.
    const st = await pixApi('/api/v1/jobs/' + encodeURIComponent(jobId));
    const text = await st.text();
    if (!st.ok) throw new Error('Pixometry status failed (HTTP ' + st.status + '): ' + text.slice(0, 200));
    let j = {};
    try { j = JSON.parse(text); } catch (_) { throw new Error('Pixometry status is not JSON: ' + text.slice(0, 200)); }

    const { state, raw, error } = jobState(j);
    if (state === 'processing') return res.status(200).json({ state, pixometryStatus: raw });
    if (state === 'failed') {
      const why = error || raw;
      return res.status(200).json({ state, error: 'Pixometry could not process the image: ' + why });
    }

    // 2. Download the result.
    const dl = await pixApi('/api/v1/jobs/' + encodeURIComponent(jobId) + '/download');
    if (!dl.ok) throw new Error('Download from Pixometry failed (HTTP ' + dl.status + ')');
    const bytes = await dl.arrayBuffer();
    const type = (dl.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const resultName = filenameFromDisposition(dl.headers.get('content-disposition'));
    const resultExt = extOf(resultName) || MIME_EXT[type] || '';
    const origExt = extOf(filename);

    // A new version must be the same file type as the original. A channel that
    // changes the type (e.g. JPEG -> PNG cut-out, WebP, PDF) is saved as a NEW FILE
    // next to the original instead: <name><suffix>.<new type>. The same happens for
    // channels the panel marks as "always a new file" (cut-outs).
    if (forceNew || (origExt && resultExt && !sameType(origExt, resultExt))) {
      // Where does the original live?
      const info = await assetsApi('/api/asset/' + encodeURIComponent(assetId));
      if (!info.ok) throw new Error('Could not read the original asset from Assets (HTTP ' + info.status + ')');
      const asset = await info.json();
      const md = asset.metadata || {};
      const origPath = String(md.assetPath || (md.folderPath && (md.filename || filename) ? md.folderPath.replace(/\/+$/, '') + '/' + (md.filename || filename) : ''));
      if (!origPath) throw new Error('Could not find the folder of the original asset');
      // The panel may ask for its own suffix (e.g. _web); only simple characters are accepted.
      const asked = String(body.suffix || '');
      const suffix = /^[A-Za-z0-9_-]{1,20}$/.test(asked) ? asked : env('NEW_FILE_SUFFIX', '_pixometry');
      const newPath = origPath.replace(/\.[A-Za-z0-9]+$/, '') + suffix + '.' + (resultExt || origExt || 'jpg');

      // Assets 10 API: POST /api/asset creates a placeholder and returns an uploadUrl;
      // the file is then uploaded to that URL with a PUT.
      const created = await assetsApi('/api/asset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetPath: newPath, autoRename: true, metadata: {}, metadataToReturn: ['assetPath', 'filename'] }),
      });
      const ctext = await created.text();
      if (!created.ok) throw new Error('Creating the new file in Assets failed (HTTP ' + created.status + '): ' + ctext.slice(0, 300));
      let c = {};
      try { c = JSON.parse(ctext); } catch (_) { throw new Error('Assets create response is not JSON'); }
      if (!c.uploadUrl) throw new Error('Assets gave no upload address for the new file');

      const put = await fetch(c.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(bytes),
      });
      if (!put.ok) throw new Error('Uploading the new file to Assets failed (HTTP ' + put.status + ')');

      const savedPath = (c.metadata && c.metadata.assetPath) || newPath;
      return res.status(200).json({
        state: 'done', savedAs: 'new', newAssetId: c.id,
        newFilename: (c.metadata && c.metadata.filename) || savedPath.split('/').pop(),
        sizeBytes: bytes.byteLength,
      });
    }

    // 3. Save as a new version of the same asset.
    //    Assets 10 API: POST /api/asset/{id}/original (multipart: file, createVersion).
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: type || 'application/octet-stream' }), filename || resultName || (assetId + '.' + (resultExt || 'jpg')));
    form.append('createVersion', 'true');
    const up = await assetsApi('/api/asset/' + encodeURIComponent(assetId) + '/original', { method: 'POST', body: form });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      throw new Error('Saving the new version in Assets failed (HTTP ' + up.status + '): ' + t.slice(0, 300));
    }
    return res.status(200).json({ state: 'done', savedAs: 'version', sizeBytes: bytes.byteLength });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
