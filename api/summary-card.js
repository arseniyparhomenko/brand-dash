// api/summary-card.js — контракт для карточки в Reports на clickup-dashboard-hub.
// GET → { metrics: [{label, value}, ...] }, value уже отформатирован строкой.
// Публичный, без пароля, CORS открыт только на clickup-dashboard-hub.vercel.app.
const L = require('./_lib');
const seed = require('../data/current.json');

function fmtNum(x) { return x == null ? '—' : Math.round(x).toLocaleString('ru-RU'); }

// Тот же формат дельты, что и в "ТОП-3 промо" на самом дашборде (см. dmini() в index.html) —
// чтобы число на карточке в хабе значило то же самое, что игрок видит здесь.
function fmtDelta(cur, prev) {
  if (typeof cur !== 'number' || typeof prev !== 'number') return '';
  if (prev === 0) return cur > 0 ? ' (▲)' : '';
  const dp = (cur - prev) / Math.abs(prev);
  if (Math.abs(dp) < 0.005) return ' (→)';
  return ' (' + (dp > 0 ? '▲' : '▼') + Math.abs(Math.round(dp * 100)) + '%)';
}

// Промо-акция с наибольшим числом участников в последнем месяце этого гео,
// плюс дельта к предыдущему месяцу по тому же промо (по имени, как и в ТОП-3 на дашборде).
function topPromo(geoMonths, months) {
  const cm = months[months.length - 1];
  const pm = months.length > 1 ? months[months.length - 2] : null;
  const promos = (geoMonths[cm] && geoMonths[cm].promos) || [];
  const withUsers = promos.filter(function (p) { return typeof p.users === 'number'; });
  if (!withUsers.length) return null;
  withUsers.sort(function (a, b) { return b.users - a.users; });
  const top = withUsers[0];
  const prevPromos = (pm && geoMonths[pm] && geoMonths[pm].promos) || [];
  const prevMatch = prevPromos.filter(function (p) { return p.name === top.name; })[0];
  const prevUsers = prevMatch && typeof prevMatch.users === 'number' ? prevMatch.users : null;
  return { top: top, delta: fmtDelta(top.users, prevUsers) };
}

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

  // Раньше здесь дублировались депозиты/retention/новые — те же цифры, что уже
  // показывает карточка Retention в хабе. Вместо этого отдаём топ-промо: свою
  // ось данных, которой ни у кого больше нет (см. ТОП-3 промо на самом дашборде).
  const geoData = (content && content.data) || {};
  const metrics = [];
  for (const geo of ['mm', 'md']) {
    const geoMonths = geoData[geo] || {};
    const months = Object.keys(geoMonths).sort(); // "YYYY-MM" — сортировка строк = хронология
    const g = GEO_LABEL[geo] || geo;
    const tp = months.length ? topPromo(geoMonths, months) : null;
    if (!tp) { metrics.push({ label: g + ': топ-промо', value: '—' }); continue; }
    metrics.push({ label: g + ': топ-промо', value: fmtNum(tp.top.users) + tp.delta });
    metrics.push({ label: g + ': промо', value: tp.top.name || '—' });
    metrics.push({ label: g + ': тип', value: [tp.top.type, tp.top.vertical].filter(Boolean).join(' · ') || '—' });
  }

  return res.status(200).json({ metrics });
};
