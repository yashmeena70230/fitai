'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createClient } = require('@libsql/client/web');

const scrypt = promisify(crypto.scrypt);
const DAY = 86400_000;

// ---------- Database (Turso) ----------
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, age INTEGER, height REAL, weight REAL, level TEXT NOT NULL DEFAULT 'Beginner', goal TEXT NOT NULL DEFAULT 'General Fitness', location TEXT NOT NULL DEFAULT 'Gym', days INTEGER NOT NULL DEFAULT 3, duration INTEGER NOT NULL DEFAULT 30, equipment TEXT NOT NULL DEFAULT '', limitations TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workouts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, duration INTEGER NOT NULL, completed_sets INTEGER NOT NULL, volume REAL NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workout_sets(id INTEGER PRIMARY KEY, workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, exercise TEXT NOT NULL, weight REAL NOT NULL, reps INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS measurements(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, weight REAL NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS workouts_user_date ON workouts(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS measurements_user_date ON measurements(user_id, created_at DESC)`,
];
let ready;
const init = () => (ready ||= db.batch(SCHEMA, 'write').catch((e) => { ready = null; throw e; }));

async function all(sql, args = []) {
  const rs = await db.execute({ sql, args });
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
}
const get = async (sql, args) => (await all(sql, args))[0];
const run = (sql, args = []) => db.execute({ sql, args });

// ---------- Helpers ----------
const limits = new Map();
const coachLimits = new Map();

function send(res, status, data, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra,
  });
  res.end(JSON.stringify(data));
}
const fail = (res, status, message) => send(res, status, { error: message });
const cookieFlags = () => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}; Secure`;
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function rateLimit(req) {
  const fwd = req.headers['x-forwarded-for'];
  const key = (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const list = (limits.get(key) || []).filter((t) => now - t < 15 * 60_000);
  list.push(now);
  limits.set(key, list);
  return list.length <= 12;
}

async function body(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 60_000) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    }
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error('Request must contain valid JSON.'), { status: 400 }); }
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return origin === `${proto}://${req.headers.host}`;
}

function sessionToken(req) {
  const raw = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('fitai_session='));
  if (!raw) return null;
  try { return decodeURIComponent(raw.slice('fitai_session='.length)); } catch { return null; }
}

async function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const hash = tokenHash(token);
  const found = await get('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash=?', [hash]);
  if (!found) return null;
  if (found.expires_at < Date.now()) { await run('DELETE FROM auth_sessions WHERE token_hash=?', [hash]); return null; }
  return (await get('SELECT id,email,name FROM users WHERE id=?', [found.user_id])) || null;
}

const profileFor = async (id) =>
  (await get('SELECT age,height,weight,level,goal,location,days,duration,equipment,limitations FROM profiles WHERE user_id=?', [id])) || null;

async function stateFor(user) {
  const sessions = await all(
    'SELECT id,plan,duration,completed_sets AS sets,volume,created_at AS date FROM workouts WHERE user_id=? ORDER BY id DESC LIMIT 100', [user.id]);
  if (sessions.length) {
    const ids = sessions.map((s) => s.id);
    const sets = await all(`SELECT workout_id,exercise,weight,reps FROM workout_sets WHERE workout_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const s of sessions) s.exercises = sets.filter((x) => x.workout_id === s.id).map(({ exercise, weight, reps }) => ({ exercise, weight, reps }));
  }
  const measurements = await all('SELECT id,weight,created_at AS date FROM measurements WHERE user_id=? ORDER BY id DESC LIMIT 100', [user.id]);
  return { user, profile: await profileFor(user.id), sessions, measurements };
}

function cleanProfile(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Profile details are required.');
  const allowed = {
    level: ['Beginner', 'Intermediate', 'Advanced'],
    goal: ['Muscle Gain', 'Fat Loss', 'Strength', 'General Fitness'],
    location: ['Home', 'Gym'],
    days: [2, 3, 4, 5, 6],
    duration: [20, 30, 45, 60],
  };
  for (const [key, values] of Object.entries(allowed)) if (!values.includes(b[key])) throw new Error(`Choose a valid ${key}.`);
  for (const [key, min, max] of [['age', 13, 100], ['height', 100, 250], ['weight', 30, 300]]) {
    if (b[key] !== '' && b[key] !== null && b[key] !== undefined && (!Number.isFinite(Number(b[key])) || Number(b[key]) < min || Number(b[key]) > max))
      throw new Error(`Check the ${key} value.`);
  }
  const text = (v, max) => String(v || '').trim().slice(0, max);
  return {
    age: b.age ? Number(b.age) : null, height: b.height ? Number(b.height) : null, weight: b.weight ? Number(b.weight) : null,
    level: b.level, goal: b.goal, location: b.location, days: Number(b.days), duration: Number(b.duration),
    equipment: text(b.equipment, 300), limitations: text(b.limitations, 500),
  };
}

async function newSession(req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await run('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [tokenHash(token), userId, Date.now() + 30 * DAY]);
  return { 'Set-Cookie': `fitai_session=${token}; ${cookieFlags(req)}` };
}

async function saveSession(req, res, user) {
  const b = await body(req);
  const plan = String(b.plan || '').trim().slice(0, 100), duration = Number(b.duration), sets = Array.isArray(b.sets) ? b.sets : [];
  if (!plan || !Number.isInteger(duration) || duration < 1 || duration > 360 || sets.length < 1 || sets.length > 200)
    return fail(res, 400, 'Add a plan, duration, and at least one completed set.');
  let volume = 0; const normalized = [];
  for (const s of sets) {
    const exercise = String(s.exercise || '').trim().slice(0, 100), weight = Number(s.weight || 0), reps = Number(s.reps || 0);
    if (!exercise || !Number.isFinite(weight) || weight < 0 || weight > 1000 || !Number.isInteger(reps) || reps < 1 || reps > 500)
      return fail(res, 400, 'Check the completed set details.');
    volume += weight * reps; normalized.push({ exercise, weight, reps });
  }
  const result = await run('INSERT INTO workouts(user_id,plan,duration,completed_sets,volume,created_at) VALUES(?,?,?,?,?,?)',
    [user.id, plan, duration, normalized.length, volume, new Date().toISOString()]);
  const id = Number(result.lastInsertRowid);
  await db.batch(normalized.map((s) => ({ sql: 'INSERT INTO workout_sets(workout_id,exercise,weight,reps) VALUES(?,?,?,?)', args: [id, s.exercise, s.weight, s.reps] })), 'write');
  return send(res, 201, { ok: true, workoutId: id, volume, sets: normalized.length });
}

async function coach(req, res, user) {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return fail(res, 503, 'The coach is not connected yet. Add AI_API_KEY in the Vercel settings.');
  const baseUrl = (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'gemini-2.5-flash';

  const now = Date.now(), recent = (coachLimits.get(user.id) || []).filter((t) => now - t < 60 * 60_000);
  if (recent.length >= 20) return fail(res, 429, 'You have reached the hourly coach limit. Try again later.');
  recent.push(now); coachLimits.set(user.id, recent);

  const b = await body(req);
  const message = String(b.message || '').trim().slice(0, 1500);
  if (!message) return fail(res, 400, 'Write a question for your coach.');
  const history = Array.isArray(b.history)
    ? b.history.slice(-8).map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, 1200) }))
    : [];

  const p = (await profileFor(user.id)) || {};
  const workouts = await all('SELECT plan,duration,completed_sets,volume,created_at FROM workouts WHERE user_id=? ORDER BY id DESC LIMIT 5', [user.id]);
  const context = {
    level: p.level || 'Beginner', goal: p.goal || 'General Fitness', location: p.location || 'Gym',
    daysPerWeek: p.days || 3, minutesPerSession: p.duration || 30,
    equipment: p.equipment || 'Not specified', limitations: p.limitations || 'Not specified',
    recentWorkouts: workouts.map((w) => ({ plan: w.plan, minutes: w.duration, sets: w.completed_sets, volumeKg: Math.round(w.volume), date: String(w.created_at).slice(0, 10) })),
  };
  const system = `You are FitAI, a careful and friendly exercise coach. The user's profile and recent workouts: ${JSON.stringify(context)}. Give practical, beginner-safe training guidance with exercises, sets, reps, rest and modifications when asked for workouts. Keep answers short and clear. Do not diagnose injuries, prescribe treatment, or encourage extreme dieting. If they mention pain or a medical condition, advise stopping the painful movement and consulting a qualified health professional. Be clear that advice is general fitness guidance.`;

  const payload = JSON.stringify({ model, max_tokens: 900, messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: message }] });
  const callModel = () => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: payload,
  });
  let response;
  try {
    response = await callModel();
    // Temporary overload (503) or rate limit (429): wait a moment and retry up to 2 more times.
    for (let i = 0; i < 2 && (response.status === 503 || response.status === 429); i++) {
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      response = await callModel();
    }
  } catch { return fail(res, 502, 'The coach service could not be reached. Try again shortly.'); }

  if (!response.ok) {
    const raw = (await response.text()).slice(0, 600);
    console.error('Coach provider error:', response.status, raw);
    if (response.status === 429) return fail(res, 429, 'The free AI limit was reached for now. Try again in a minute.');
    if (response.status === 503) return fail(res, 503, 'The AI service is busy right now. Please try again in a minute.');
    let detail = raw;
    try { const j = JSON.parse(raw); detail = (Array.isArray(j) ? j[0] : j)?.error?.message || raw; } catch {}
    detail = String(detail).replace(/AQ\.[\w.-]+|AIza[\w-]+/g, '[key]').slice(0, 220);
    return fail(res, 502, `Coach error ${response.status} (model: ${model}): ${detail}`);
  }
  const result = await response.json();
  const text = result?.choices?.[0]?.message?.content || '';
  if (!text) return fail(res, 502, 'The coach did not return a reply. Try again.');
  return send(res, 200, { reply: text });
}

// ---------- Routes ----------
async function api(req, res) {
  const route = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '');
  if (req.method === 'GET' && route === '/api/health') return send(res, 200, { ok: true });
  if (!originOk(req)) return fail(res, 403, 'Request origin is not allowed.');
  if (!process.env.TURSO_DATABASE_URL) return fail(res, 500, 'Database is not configured. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Vercel settings.');
  await init();

  if (req.method === 'POST' && (route === '/api/auth/register' || route === '/api/auth/login') && !rateLimit(req))
    return fail(res, 429, 'Too many attempts. Wait a little and try again.');

  if (req.method === 'POST' && route === '/api/auth/register') {
    const b = await body(req), email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim().slice(0, 80), password = String(b.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address.');
    if (password.length < 10 || password.length > 200) return fail(res, 400, 'Use a password with at least 10 characters.');
    if (!name) return fail(res, 400, 'Enter your name.');
    const salt = crypto.randomBytes(16).toString('hex'), hash = (await scrypt(password, salt, 64)).toString('hex');
    try {
      const ins = await run('INSERT INTO users(email,name,salt,password_hash,created_at) VALUES(?,?,?,?,?)', [email, name, salt, hash, new Date().toISOString()]);
      const id = Number(ins.lastInsertRowid);
      await run('INSERT INTO profiles(user_id,updated_at) VALUES(?,?)', [id, new Date().toISOString()]);
      const cookie = await newSession(req, id);
      return send(res, 201, { state: await stateFor({ id, email, name }) }, cookie);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return fail(res, 409, 'An account with this email already exists.');
      throw e;
    }
  }

  if (req.method === 'POST' && route === '/api/auth/login') {
    const b = await body(req), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    const u = await get('SELECT * FROM users WHERE email=?', [email]);
    const candidate = u ? await scrypt(password, u.salt, 64) : Buffer.alloc(64);
    if (!u || !crypto.timingSafeEqual(candidate, Buffer.from(u.password_hash, 'hex'))) return fail(res, 401, 'Email or password is incorrect.');
    const cookie = await newSession(req, u.id);
    return send(res, 200, { state: await stateFor({ id: u.id, email: u.email, name: u.name }) }, cookie);
  }

  if (req.method === 'POST' && route === '/api/auth/logout') {
    const token = sessionToken(req);
    if (token) await run('DELETE FROM auth_sessions WHERE token_hash=?', [tokenHash(token)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `fitai_session=; ${cookieFlags(req)}; Max-Age=0` });
  }

  if (req.method === 'GET' && route === '/api/auth/me') {
    const user = await currentUser(req);
    return send(res, 200, { state: user ? await stateFor(user) : null });
  }

  const user = await currentUser(req);
  if (!user) return fail(res, 401, 'Please sign in to continue.');

  if (req.method === 'GET' && route === '/api/state') return send(res, 200, { state: await stateFor(user) });

  if (req.method === 'PUT' && route === '/api/profile') {
    const b = await body(req); let p;
    try { p = cleanProfile(b); } catch (e) { return fail(res, 400, e.message); }
    await run(`INSERT INTO profiles(user_id,age,height,weight,level,goal,location,days,duration,equipment,limitations,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET age=excluded.age,height=excluded.height,weight=excluded.weight,level=excluded.level,goal=excluded.goal,location=excluded.location,days=excluded.days,duration=excluded.duration,equipment=excluded.equipment,limitations=excluded.limitations,updated_at=excluded.updated_at`,
      [user.id, p.age, p.height, p.weight, p.level, p.goal, p.location, p.days, p.duration, p.equipment, p.limitations, new Date().toISOString()]);
    return send(res, 200, { profile: await profileFor(user.id) });
  }

  if (req.method === 'GET' && route === '/api/workouts') return send(res, 200, { sessions: (await stateFor(user)).sessions });
  if (req.method === 'POST' && route === '/api/workouts') return saveSession(req, res, user);

  if (req.method === 'POST' && route === '/api/measurements') {
    const b = await body(req), weight = Number(b.weight);
    if (!Number.isFinite(weight) || weight < 30 || weight > 300) return fail(res, 400, 'Enter a weight between 30 and 300 kg.');
    await run('INSERT INTO measurements(user_id,weight,created_at) VALUES(?,?,?)', [user.id, weight, new Date().toISOString()]);
    return send(res, 201, { measurements: (await stateFor(user)).measurements });
  }
  if (req.method === 'GET' && route === '/api/measurements') return send(res, 200, { measurements: (await stateFor(user)).measurements });

  if (req.method === 'POST' && route === '/api/coach') return coach(req, res, user);

  return fail(res, 404, 'Not found.');
}

module.exports = async (req, res) => {
  try { await api(req, res); }
  catch (e) {
    if (e.status && e.status < 500) return fail(res, e.status, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Something went wrong. Please try again.'); else res.end();
  }
};
