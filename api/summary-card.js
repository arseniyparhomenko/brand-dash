// api/summary-card.js — контракт для карточки в Reports на clickup-dashboard-hub.
// GET → { metrics: [{label, value}, ...] }, value уже отформатирован строкой.
// Публичный, без пароля, CORS открыт только на clickup-dashboard-hub.vercel.app.
const L = require('./_lib');
const seed = require('../data/current.json');

function fmtPct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }
function fmtNum(x) { return x == null ? '—' : Math.round(x).toLocaleString('ru-RU'); }

const GEO_LABEL = { mm: 'MM', md: 'MD' };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', 'https://clickup-dashboard-hub.vercel.app');

  let content = seed;
  if (L.redisConfig()) {
    try {
      const raw = await L.redis(['GET', L.KEY_CURRENT]);
      if (raw) {
        const obj = JSON.parse(raw);
        content = obj.data || seed;
      }
    } catch (e) {
      // хранилище легло — используем seed из репозитория, лучше старые цифры, чем пустая карточка
    }
  }

  const geoData = (content && content.data) || {};
  const metrics = [];
  for (const geo of ['mm', 'md']) {
    const months = Object.keys(geoData[geo] || {}).sort(); // "YYYY-MM" — сортировка строк = хронология
    const last = months[months.length - 1];
    const t = (last && geoData[geo][last] && geoData[geo][last].totals) || {};
    const g = GEO_LABEL[geo] || geo;
    metrics.push({ label: g + ': депозиты', value: fmtNum(t.depositsTotal) });
    metrics.push({ label: g + ': retention', value: fmtPct(t.retentionRate) });
    metrics.push({ label: g + ': новых', value: fmtNum(t.newRegistrations) });
  }

  return res.status(200).json({ metrics });
};
