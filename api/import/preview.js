const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (!L.hasSession(req)) return res.status(401).json({ error: 'сессия истекла', relogin: true });
  if (!L.redisConfig()) return res.status(501).json({ error: 'хранилище не подключено' });

  const body = L.readBody(req);
  if (!body || typeof body.html !== 'string' || !body.html.trim()) {
    return res.status(400).json({ error: 'пустой файл' });
  }

  let incoming;
  try {
    incoming = L.extractEmbeddedData(body.html);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const rawNow = await L.redis(['GET', L.KEY_CURRENT]);
    const now = rawNow ? JSON.parse(rawNow) : { rev: 0, data: {}, geos: [], months: [], tournaments: {} };
    const currentRev = now.rev || 0;

    // now хранит {rev, savedAt, data:{geos,months,data,tournaments,meta}} — берём вложенный дашборд
    const currentDashboard = now.data || now;
    let merged, diff;
    try {
      const plan = L.planImport(currentDashboard, incoming);
      merged = plan.merged; diff = plan.diff;
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!diff.months.length) {
      return res.status(400).json({
        error: 'в файле не нашлось ни одного месяца в формате YYYY-MM для известных гео (' +
               (currentDashboard.geos || []).map(function (g) { return g.id; }).join(', ') + ')'
      });
    }

    const token = L.randToken();
    await L.redis(['SET', L.keyImport(token),
      JSON.stringify({ merged: merged, baseRev: currentRev }), 'EX', String(L.IMPORT_TTL)]);

    return res.status(200).json({ ok: true, token: token, diff: diff, ttl: L.IMPORT_TTL });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
