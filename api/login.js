const L = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // GET — «я ещё залогинен?». Страница спрашивает при загрузке,
  // чтобы не просить пароль второй раз в течение смены.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: L.hasSession(req) });
  }

  if (req.method === 'DELETE') {
    L.clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'только POST' });

  if (!process.env.EDIT_PASSWORD) {
    return res.status(500).json({ error: 'на сервере не задана переменная EDIT_PASSWORD' });
  }

  const body = L.readBody(req);
  await new Promise(r => setTimeout(r, 400)); // тормозим перебор

  if (!body || !L.passwordMatches(body.password || '')) {
    return res.status(401).json({ ok: false, error: 'неверный пароль' });
  }

  L.setSessionCookie(res);
  return res.status(200).json({ ok: true });
};
