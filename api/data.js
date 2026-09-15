const L = require('./_lib');
const seed = require('../data/current.json');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!L.redisConfig()) {
    // хранилище не подключено — отдаём файл из репозитория, только чтение
    return res.status(200).json({ data: seed, rev: 0, savedAt: null, storage: false });
  }

  try {
    const raw = await L.redis(['GET', L.KEY_CURRENT]);
    if (!raw) {
      return res.status(200).json({ data: seed, rev: 0, savedAt: null, storage: true });
    }
    const obj = JSON.parse(raw);
    return res.status(200).json({
      data: obj.data,
      rev: obj.rev || 0,
      savedAt: obj.savedAt || null,
      storage: true
    });
  } catch (e) {
    // хранилище легло — лучше показать вчерашние цифры из репозитория, чем пустой экран
    return res.status(200).json({
      data: seed, rev: 0, savedAt: null, storage: false, warning: e.message
    });
  }
};
