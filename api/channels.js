// GET /api/channels
// Lists the Pixometry channels (workflows) the panel may offer as buttons.

const { guard, pixChannels } = require('../lib/shared');

module.exports = async (req, res) => {
  if (!guard(req, res, 'GET')) return;
  try {
    return res.status(200).json({ channels: await pixChannels() });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
