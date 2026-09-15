const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!L.hasSession(req)) {
    return res.status(401).json({ error: 'сессия истекла', relogin: true });
  }
  if (!L.redisConfig()) {
    return res.status(501).json({ error: 'хранилище не подключено' });
  }

  try {
    // GET — список версий (без самих данных, чтобы не гонять мегабайты)
    if (req.method === 'GET') {
      const rows = (await L.redis(['LRANGE', L.KEY_HISTORY, 0, L.HISTORY_MAX - 1])) || [];
      const list = rows.map(function (s, i) {
        try {
          const o = JSON.parse(s);
          return { i: i, rev: o.rev, savedAt: o.savedAt };
        } catch (e) { return { i: i, rev: null, savedAt: null }; }
      });
      return res.status(200).json({ ok: true, versions: list });
    }

    // POST {i} — откатиться к версии с этим номером в списке
    if (req.method === 'POST') {
      const body = L.readBody(req) || {};
      const i = parseInt(body.i, 10);
      if (isNaN(i) || i < 0) return res.status(400).json({ error: 'не указан номер версии' });

      const rows = (await L.redis(['LRANGE', L.KEY_HISTORY, i, i])) || [];
      if (!rows.length) return res.status(404).json({ error: 'версия не найдена' });

      const old = JSON.parse(rows[0]);
      const bad = L.validate(old.data);
      if (bad) return res.status(400).json({ error: 'битая версия: ' + bad });

      const rawNow = await L.redis(['GET', L.KEY_CURRENT]);
      const nowRev = rawNow ? (JSON.parse(rawNow).rev || 0) : 0;

      const rec = {
        rev: nowRev + 1,
        savedAt: new Date().toISOString(),
        restoredFrom: old.savedAt,
        data: old.data
      };
      const payload = JSON.stringify(rec);
      await L.redis(['SET', L.KEY_CURRENT, payload]);
      await L.redis(['LPUSH', L.KEY_HISTORY, payload]);
      await L.redis(['LTRIM', L.KEY_HISTORY, 0, L.HISTORY_MAX - 1]);

      return res.status(200).json({ ok: true, rev: rec.rev, data: old.data });
    }

    return res.status(405).json({ error: 'только GET или POST' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
