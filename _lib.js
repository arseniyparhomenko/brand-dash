// Общие помощники. Файлы с «_» в начале Vercel не превращает в эндпоинты.

const crypto = require('crypto');

/* ---------------- хранилище: Upstash Redis через REST, без npm-зависимостей ---------------- */

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

async function redis(command) {
  const cfg = redisConfig();
  if (!cfg) throw new Error('хранилище не подключено (нет KV_REST_API_URL / KV_REST_API_TOKEN)');
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.error) {
    throw new Error('хранилище: ' + ((j && j.error) || ('HTTP ' + r.status)));
  }
  return j.result;
}

const KEY_CURRENT = 'brand-dash:current';
const KEY_HISTORY = 'brand-dash:history';
const HISTORY_MAX = 40;
const IMPORT_TTL = 900; // 15 минут на просмотр диффа, потом токен протухает
function keyImport(token) { return 'brand-dash:import:' + token; }
function randToken() { return crypto.randomBytes(16).toString('base64url'); }

/* ---------------- сессия ---------------- */
// Токен = exp.HMAC(exp). Ключ HMAC выводится из пароля, поэтому смена пароля
// автоматически разлогинивает всех. Отдельную переменную заводить не нужно.

function hmac(value) {
  const secret = (process.env.SESSION_SECRET || process.env.EDIT_PASSWORD || '') + '|brand-dash';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

function makeToken(ttlSeconds) {
  const exp = Date.now() + ttlSeconds * 1000;
  return exp + '.' + hmac(exp);
}

function tokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = hmac(exp);
  if (sig.length !== good.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

const COOKIE = 'bd_session';
const TTL = 12 * 60 * 60; // 12 часов

function setSessionCookie(res) {
  res.setHeader('Set-Cookie',
    COOKIE + '=' + makeToken(TTL) +
    '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + TTL);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
}
function hasSession(req) {
  return tokenValid(readCookie(req, COOKIE));
}

/* ---------------- пароль ---------------- */

function passwordMatches(given) {
  const expected = process.env.EDIT_PASSWORD;
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/* ---------------- валидация данных ---------------- */

function validate(d) {
  if (!d || typeof d !== 'object') return 'нет объекта данных';
  if (!Array.isArray(d.geos) || !d.geos.length) return 'пустой список гео';
  if (!Array.isArray(d.months) || !d.months.length) return 'пустой список месяцев';
  if (!d.data || typeof d.data !== 'object') return 'нет поля data';
  return null;
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  return b || null;
}

/* ================= импорт месячного артефакта ================= */
// Настя (в своём личном Клоде) каждый месяц собирает HTML-дашборд.
// Мы достаём из него встроенный JSON и аккуратно доливаем в общую историю:
// новые месяцы дописываются, существующие — по явному подтверждению перезаписываются,
// турниры (они живут дольше одного месяца) сверяются по имени, а не переписываются целиком.

const SECTION_KEYS = [
  'promos', 'vip', 'channels', 'topSport', 'topCasino', 'reactivation',
  'agentSends', 'agentTests', 'projects', 'plans'
];

const LEGACY_MONTH_KEYS = ['agents', 'agentSends', 'agentTests'];

function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Достаём JSON из <script id="data" type="application/json">...</script>.
// Работает и с полным HTML-файлом Насти, и с чистым JSON, если кто-то пришлёт его так.
function extractEmbeddedData(text) {
  const s = String(text || '').trim();
  if (s[0] === '{') {
    try { return JSON.parse(s); } catch (e) { throw new Error('это похоже на JSON, но он не разобрался: ' + e.message); }
  }
  const m = s.match(/<script[^>]*id=["']data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('не нашёл в файле блок <script id="data">. Это точно артефакт дашборда?');
  try { return JSON.parse(m[1]); } catch (e) { throw new Error('нашёл блок данных, но JSON внутри битый: ' + e.message); }
}

function countFields(month) {
  if (!month || typeof month !== 'object') return null;
  const out = { totals: Object.keys(month.totals || {}).length };
  SECTION_KEYS.forEach(function (k) { out[k] = Array.isArray(month[k]) ? month[k].length : 0; });
  out.tournaments = Array.isArray(month.tournaments) ? month.tournaments.length : 0;
  out.retention = (month.retention && Object.keys(month.retention).length) ? 'заполнено' : 'пусто';
  return out;
}

// Spend/Revenue у промо не заполнялись ни в одном месяце, поэтому «пусто у всех» — не ошибка и не предупреждение.
// Предупреждаем только если заполнено частично: тогда, скорее всего, что-то потерялось.
function promoWarnings(month) {
  const promos = Array.isArray(month && month.promos) ? month.promos : [];
  const w = [];
  [['spend', 'Spend'], ['revenue', 'Revenue']].forEach(function (f) {
    const empty = promos.filter(function (p) { return p[f[0]] === null || p[f[0]] === undefined; }).length;
    if (empty && empty < promos.length) w.push(empty + ' из ' + promos.length + ' промо без ' + f[1]);
  });
  return w;
}

// Считает результат слияния и человекочитаемый дифф за один проход.
// current не мутируется — возвращается новый объект.
function planImport(current, incoming) {
  const bad = validate(incoming);
  if (bad) throw new Error('файл не похож на данные дашборда: ' + bad);

  const merged = JSON.parse(JSON.stringify(current));
  merged.meta = merged.meta || {};
  merged.meta.tournamentSeq = merged.meta.tournamentSeq || {};
  merged.tournaments = merged.tournaments || {};

  const knownGeoIds = merged.geos.map(function (g) { return g.id; });
  const monthIndex = {}; merged.months.forEach(function (m, i) { monthIndex[m.id] = i; });

  const diff = { months: [], warnings: [], tournaments: {}, newTournaments: [], agentsBoard: [], unknownGeos: [] };

  const incomingGeoIds = Object.keys(incoming.data || {});
  incomingGeoIds.forEach(function (geoId) {
    if (knownGeoIds.indexOf(geoId) < 0) { diff.unknownGeos.push(geoId); return; }

    if (!merged.tournaments[geoId]) merged.tournaments[geoId] = [];
    if (!merged.meta.tournamentSeq[geoId]) merged.meta.tournamentSeq[geoId] = merged.tournaments[geoId].length;

    let matched = 0, added = 0;
    const monthIds = Object.keys(incoming.data[geoId] || {});

    monthIds.forEach(function (monthId) {
      if (!/^\d{4}-\d{2}$/.test(monthId)) { diff.warnings.push('гео ' + geoId + ': месяц "' + monthId + '" не похож на YYYY-MM, пропустил'); return; }
      const incMonth = incoming.data[geoId][monthId];
      merged.data[geoId] = merged.data[geoId] || {};
      const prevMonth = merged.data[geoId][monthId];
      const isNew = !prevMonth;

      // сам месяц: берём целиком, как прислали — так и задумано, она пересобирает месяц с нуля.
      // Исключение — рассылки агентов: в новом формате они живут в agentsBoard, а не в месяце,
      // поэтому старые помесячные записи не стираем, если в файле этих полей нет.
      merged.data[geoId][monthId] = incMonth;
      // если файл принёс agentsBoard для этого гео — старые помесячные рассылки больше не нужны
      const hasBoard = !!(incoming.agentsBoard && incoming.agentsBoard[geoId]);
      if (prevMonth && !hasBoard) {
        LEGACY_MONTH_KEYS.forEach(function (k) {
          if (incMonth[k] === undefined && prevMonth[k] !== undefined) incMonth[k] = prevMonth[k];
        });
      }

      if (!(monthId in monthIndex)) {
        const label = (incoming.months || []).filter(function (m) { return m.id === monthId; })[0];
        merged.months.push({ id: monthId, label: label ? label.label : monthId });
        merged.months.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
        monthIndex[monthId] = merged.months.length;
      }

      var labelRow = merged.months.filter(function (m) { return m.id === monthId; })[0];
      diff.months.push({
        geo: geoId, id: monthId,
        label: labelRow ? labelRow.label : monthId,
        action: isNew ? 'new' : 'overwrite',
        fields: countFields(incMonth),
        warnings: promoWarnings(incMonth)
      });

      // турниры этого месяца — сверяем с историей по имени
      const rows = Array.isArray(incMonth.tournaments) ? incMonth.tournaments : [];
      rows.forEach(function (t) {
        const key = normName(t.name);
        if (!key) return;
        const existing = merged.tournaments[geoId].filter(function (x) { return normName(x.name) === key; })[0];
        if (existing) {
          matched++;
          existing.period = t.period || existing.period;
          existing.game = t.game || existing.game;
          existing.playersByMonth = existing.playersByMonth || {};
          existing.usesByMonth = existing.usesByMonth || {};
          if (typeof t.players === 'number') existing.playersByMonth[monthId] = t.players;
          if (typeof t.uses === 'number') existing.usesByMonth[monthId] = t.uses;
        } else {
          added++;
          merged.meta.tournamentSeq[geoId]++;
          merged.tournaments[geoId].push({
            id: geoId + '-' + merged.meta.tournamentSeq[geoId],
            name: t.name, period: t.period || '', game: t.game || '',
            playersByMonth: typeof t.players === 'number' ? Object.fromEntries([[monthId, t.players]]) : {},
            usesByMonth: typeof t.uses === 'number' ? Object.fromEntries([[monthId, t.uses]]) : {}
          });
        }
      });
    });

    if (matched || added) diff.tournaments[geoId] = { matched: matched, added: added };
  });

  // турниры верхнего уровня (новый формат: у каждого гео список с playersByMonth/usesByMonth)
  Object.keys(incoming.tournaments || {}).forEach(function (geoId) {
    if (knownGeoIds.indexOf(geoId) < 0) return;
    const list = Array.isArray(incoming.tournaments[geoId]) ? incoming.tournaments[geoId] : [];
    merged.tournaments[geoId] = merged.tournaments[geoId] || [];
    if (!merged.meta.tournamentSeq[geoId]) merged.meta.tournamentSeq[geoId] = merged.tournaments[geoId].length;
    const stat = diff.tournaments[geoId] || { matched: 0, added: 0 };
    list.forEach(function (t) {
      const key = normName(t.name);
      if (!key) return;
      const existing = merged.tournaments[geoId].filter(function (x) { return normName(x.name) === key; })[0];
      if (existing) {
        stat.matched++;
        existing.period = t.period || existing.period;
        existing.game = t.game || existing.game;
        existing.playersByMonth = Object.assign(existing.playersByMonth || {}, t.playersByMonth || {});
        existing.usesByMonth = Object.assign(existing.usesByMonth || {}, t.usesByMonth || {});
      } else {
        stat.added++;
        merged.meta.tournamentSeq[geoId]++;
        merged.tournaments[geoId].push({
          id: geoId + '-' + merged.meta.tournamentSeq[geoId],
          name: t.name, period: t.period || '', game: t.game || '',
          playersByMonth: Object.assign({}, t.playersByMonth || {}),
          usesByMonth: Object.assign({}, t.usesByMonth || {})
        });
        diff.newTournaments.push(geoId + ': ' + t.name);
      }
    });
    if (stat.matched || stat.added) diff.tournaments[geoId] = stat;
  });

  // «Поиск агентов»: накопительная база по гео, файл всегда присылает её целиком — заменяем по гео
  if (incoming.agentsBoard && typeof incoming.agentsBoard === 'object') {
    merged.agentsBoard = merged.agentsBoard || {};
    Object.keys(incoming.agentsBoard).forEach(function (geoId) {
      if (knownGeoIds.indexOf(geoId) < 0) return;
      const b = incoming.agentsBoard[geoId] || {};
      merged.agentsBoard[geoId] = b;
      diff.agentsBoard.push({
        geo: geoId,
        sends: Array.isArray(b.sends) ? b.sends.length : 0,
        tests: Array.isArray(b.tests) ? b.tests.length : 0
      });
    });
  }

  if (incoming.meta && incoming.meta.updated) merged.meta.updated = incoming.meta.updated;

  return { merged: merged, diff: diff };
}

module.exports = {
  redis, redisConfig, KEY_CURRENT, KEY_HISTORY, HISTORY_MAX,
  IMPORT_TTL, keyImport, randToken,
  setSessionCookie, clearSessionCookie, hasSession,
  passwordMatches, validate, readBody,
  extractEmbeddedData, planImport
};
