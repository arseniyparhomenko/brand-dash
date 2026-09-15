const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });
  if (!L.hasSession(req)) return res.status(401).json({ error: 'сессия истекла', relogin: true });
  if (!L.redisConfig()) return res.status(501).json({ error: 'хранилище не подключено' });

  const body = L.readBody(req);
  const token = body && body.token;
  if (!token) return res.status(400).json({ error: 'нет токена предпросмотра' });

  try {
    const rawPending = await L.redis(['GET', L.keyImport(token)]);
    if (!rawPending) {
      return res.status(410).json({ error: 'предпросмотр устарел (прошло больше 15 минут). Загрузите файл заново.' });
    }
    const pending = JSON.parse(rawPending);

    const rawNow = await L.redis(['GET', L.KEY_CURRENT]);
    const now = rawNow ? JSON.parse(rawNow) : { rev: 0 };
    const liveRev = now.rev || 0;

    if (liveRev !== pending.baseRev) {
      return res.status(409).json({
        error: 'кто-то сохранил данные, пока вы смотрели предпросмотр. Загрузите файл заново.',
        conflict: true
      });
    }

    const rec = { rev: liveRev + 1, savedAt: new Date().toISOString(), data: pending.merged };
    const payload = JSON.stringify(rec);
    await L.redis(['SET', L.KEY_CURRENT, payload]);
    await L.redis(['LPUSH', L.KEY_HISTORY, payload]);
    await L.redis(['LTRIM', L.KEY_HISTORY, 0, L.HISTORY_MAX - 1]);
    await L.redis(['DEL', L.keyImport(token)]);

    return res.status(200).json({ ok: true, rev: rec.rev, savedAt: rec.savedAt });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
