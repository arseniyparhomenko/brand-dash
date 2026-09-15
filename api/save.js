const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });

  if (!L.hasSession(req)) {
    return res.status(401).json({ error: 'сессия истекла', relogin: true });
  }
  if (!L.redisConfig()) {
    return res.status(501).json({
      error: 'хранилище не подключено — сохранять некуда. Подключите Redis в настройках проекта.'
    });
  }

  const body = L.readBody(req);
  if (!body) return res.status(400).json({ error: 'тело запроса не разобралось' });

  const bad = L.validate(body.data);
  if (bad) return res.status(400).json({ error: bad });

  try {
    // текущая ревизия — чтобы поймать чужую параллельную правку
    const rawNow = await L.redis(['GET', L.KEY_CURRENT]);
    const now = rawNow ? JSON.parse(rawNow) : { rev: 0 };
    const serverRev = now.rev || 0;
    const clientRev = typeof body.rev === 'number' ? body.rev : null;

    if (clientRev !== null && clientRev !== serverRev && body.force !== true) {
      return res.status(409).json({
        error: 'данные успели изменить в другой вкладке или у другого человека',
        conflict: true, serverRev: serverRev, clientRev: clientRev
      });
    }

    const rec = {
      rev: serverRev + 1,
      savedAt: new Date().toISOString(),
      data: body.data
    };
    const payload = JSON.stringify(rec);

    await L.redis(['SET', L.KEY_CURRENT, payload]);

    // снимок для отката: храним последние N версий
    await L.redis(['LPUSH', L.KEY_HISTORY, payload]);
    await L.redis(['LTRIM', L.KEY_HISTORY, 0, L.HISTORY_MAX - 1]);

    return res.status(200).json({ ok: true, rev: rec.rev, savedAt: rec.savedAt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
