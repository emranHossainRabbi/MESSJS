const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const DB_FILE = path.join(__dirname, 'mess.db');
const db = new Database(DB_FILE);
const HOUSE_CODE = process.env.HOUSE_CODE || 'mess123'; // members need this to register

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, pw TEXT, is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS meals(user_id INTEGER, day TEXT, breakfast REAL DEFAULT 0, lunch REAL DEFAULT 0, dinner REAL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, user_id INTEGER, day TEXT, item TEXT, amount REAL);
`);

// Upgrade an older database that only had a single meal count per day
if (!db.prepare('PRAGMA table_info(meals)').all().some(c => c.name === 'lunch')) {
  db.exec(`ALTER TABLE meals ADD COLUMN breakfast REAL DEFAULT 0;
           ALTER TABLE meals ADD COLUMN lunch REAL DEFAULT 0;
           ALTER TABLE meals ADD COLUMN dinner REAL DEFAULT 0;
           UPDATE meals SET lunch = COALESCE(count, 0);`);
}

app.set('view engine', 'ejs');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SECRET_KEY || 'change-this-secret',
  maxAge: 30 * 24 * 3600 * 1000,
}));
app.use((req, res, next) => {
  res.locals.user = req.session.uid ? req.session : null;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.g = (n) => +Number(n).toFixed(2);   // 2 -> 2, 2.5 -> 2.5
  res.locals.f0 = (n) => Number(n).toFixed(0);
  res.locals.f2 = (n) => Number(n).toFixed(2);
  next();
});

const needLogin = (req, res, next) => (req.session.uid ? next() : res.redirect('/login'));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

function stats(month) {
  const like = month + '%';
  const rows = db.prepare(`
    SELECT u.id, u.name,
      COALESCE((SELECT SUM(breakfast+lunch+dinner) FROM meals    WHERE user_id=u.id AND day LIKE ?),0) AS meals,
      COALESCE((SELECT SUM(amount) FROM expenses WHERE user_id=u.id AND day LIKE ?),0) AS spent
    FROM users u ORDER BY u.name`).all(like, like);
  const tm = rows.reduce((a, r) => a + r.meals, 0);
  const te = rows.reduce((a, r) => a + r.spent, 0);
  const rate = tm ? te / tm : 0;
  return { tm, te, rate, rows: rows.map(r => ({ ...r, cost: r.meals * rate, balance: r.spent - r.meals * rate })) };
}

app.get('/register', (req, res) => res.render('auth', { mode: 'register' }));
app.post('/register', (req, res) => {
  const name = (req.body.name || '').trim(), pw = req.body.pw || '';
  const err = (m) => res.render('auth', { mode: 'register', flash: m });
  if (req.body.code !== HOUSE_CODE) return err('Wrong house code.');
  if (!name || pw.length < 4) return err('Enter a name and a password of at least 4 characters.');
  const first = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
  try {
    db.prepare('INSERT INTO users(name,pw,is_admin) VALUES(?,?,?)').run(name, bcrypt.hashSync(pw, 10), first ? 1 : 0);
  } catch (e) { return err('That name is already taken.'); }
  req.session.flash = 'Account created. Log in now.';
  res.redirect('/login');
});

app.get('/login', (req, res) => res.render('auth', { mode: 'login' }));
app.post('/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE name=?').get((req.body.name || '').trim());
  if (!u || !bcrypt.compareSync(req.body.pw || '', u.pw)) return res.render('auth', { mode: 'login', flash: 'Wrong name or password.' });
  req.session = { uid: u.id, name: u.name, admin: !!u.is_admin };
  res.redirect('/');
});
app.get('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/', needLogin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { rows, tm, te, rate } = stats(month);
  const me = rows.find(r => r.id === req.session.uid);
  if (!me) { req.session = null; return res.redirect('/login'); }
  const like = month + '%';
  const meals = db.prepare('SELECT day,breakfast,lunch,dinner FROM meals WHERE user_id=? AND day LIKE ? ORDER BY day DESC').all(me.id, like);
  const exps = db.prepare('SELECT * FROM expenses WHERE user_id=? AND day LIKE ? ORDER BY day DESC').all(me.id, like);
  const houseExps = db.prepare(`SELECT e.day, e.item, e.amount, u.name FROM expenses e JOIN users u ON u.id=e.user_id
                                WHERE e.day LIKE ? ORDER BY e.day DESC, e.id DESC`).all(like);
  const tt = db.prepare(`SELECT COALESCE(SUM(breakfast),0) AS breakfast, COALESCE(SUM(lunch),0) AS lunch,
                         COALESCE(SUM(dinner),0) AS dinner FROM meals WHERE day=?`).get(today());
  res.render('dashboard', { month, me, tm, te, rate, meals, exps, houseExps, tt, today: today(), everyone: req.session.admin ? rows : null });
});

// Same date again = edit. 0 = no meal.
app.post('/meal', needLogin, (req, res) => {
  const day = req.body.day;
  const v = ['breakfast', 'lunch', 'dinner'].map(k => parseFloat(req.body[k]) || 0);
  if (DAY.test(day) && v.every(n => n >= 0 && n <= 10)) {
    db.prepare(`INSERT INTO meals(user_id,day,breakfast,lunch,dinner) VALUES(?,?,?,?,?)
                ON CONFLICT(user_id,day) DO UPDATE SET breakfast=excluded.breakfast, lunch=excluded.lunch, dinner=excluded.dinner`)
      .run(req.session.uid, day, ...v);
  }
  res.redirect('/?month=' + (day || '').slice(0, 7));
});

// House page: who is eating and what was bought on a given day (all members)
app.get('/day', needLogin, (req, res) => {
  const day = DAY.test(req.query.day || '') ? req.query.day : today();
  const rows = db.prepare(`
    SELECT u.name, COALESCE(m.breakfast,0) AS breakfast, COALESCE(m.lunch,0) AS lunch, COALESCE(m.dinner,0) AS dinner
    FROM users u LEFT JOIN meals m ON m.user_id=u.id AND m.day=? ORDER BY u.name`).all(day);
  const sum = k => rows.reduce((a, r) => a + r[k], 0);
  const exps = db.prepare(`SELECT e.item, e.amount, u.name FROM expenses e JOIN users u ON u.id=e.user_id
                           WHERE e.day=? ORDER BY e.id DESC`).all(day);
  res.render('day', { day, rows, exps, totals: { breakfast: sum('breakfast'), lunch: sum('lunch'), dinner: sum('dinner') } });
});

app.post('/expense', needLogin, (req, res) => {
  const { day, item } = req.body, amt = parseFloat(req.body.amount);
  if (DAY.test(day) && (item || '').trim() && amt >= 0) {
    db.prepare('INSERT INTO expenses(user_id,day,item,amount) VALUES(?,?,?,?)').run(req.session.uid, day, item.trim(), amt);
  }
  res.redirect('/?month=' + (day || '').slice(0, 7));
});

app.post('/expense/:id/delete', needLogin, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=? AND user_id=?').run(req.params.id, req.session.uid);
  res.redirect(req.get('Referer') || '/');
});


// ---------- Admin portal ----------
const adminOnly = (req, res, next) => (req.session.admin ? next() : res.redirect('/'));
const back = (req, res, msg) => {
  if (msg) req.session.flash = msg;
  const m = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : today().slice(0, 7);
  res.redirect('/admin?month=' + m);
};
const admin = [needLogin, adminOnly];
const saveMeal = (uid, day, v) => db.prepare(`INSERT INTO meals(user_id,day,breakfast,lunch,dinner) VALUES(?,?,?,?,?)
  ON CONFLICT(user_id,day) DO UPDATE SET breakfast=excluded.breakfast, lunch=excluded.lunch, dinner=excluded.dinner`).run(uid, day, ...v);

app.get('/admin', admin, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const { rows, tm, te, rate } = stats(month);
  const members = db.prepare('SELECT id,name,is_admin FROM users ORDER BY name').all();
  const exps = db.prepare(`SELECT e.*, u.name FROM expenses e JOIN users u ON u.id=e.user_id
                           WHERE e.day LIKE ? ORDER BY e.day DESC, e.id DESC`).all(month + '%');
  res.render('admin', { month, rows, tm, te, rate, members, exps, today: today() });
});

app.post('/admin/member', admin, (req, res) => {
  const name = (req.body.name || '').trim(), pw = req.body.pw || '';
  if (!name || pw.length < 4) return back(req, res, 'Enter a name and a password of at least 4 characters.');
  try {
    db.prepare('INSERT INTO users(name,pw,is_admin) VALUES(?,?,0)').run(name, bcrypt.hashSync(pw, 10));
    back(req, res, 'Member added.');
  } catch (e) { back(req, res, 'That name is already taken.'); }
});

app.post('/admin/member/:id/password', admin, (req, res) => {
  const pw = req.body.pw || '';
  if (pw.length < 4) return back(req, res, 'Password must be at least 4 characters.');
  db.prepare('UPDATE users SET pw=? WHERE id=?').run(bcrypt.hashSync(pw, 10), req.params.id);
  back(req, res, 'Password changed.');
});

app.post('/admin/member/:id/role', admin, (req, res) => {
  const id = +req.params.id;
  if (id === req.session.uid) return back(req, res, 'You cannot change your own role.');
  const u = db.prepare('SELECT is_admin FROM users WHERE id=?').get(id);
  if (!u) return back(req, res);
  db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(u.is_admin ? 0 : 1, id);
  back(req, res, 'Role updated.');
});

app.post('/admin/member/:id/delete', admin, (req, res) => {
  const id = +req.params.id;
  if (id === req.session.uid) return back(req, res, 'You cannot delete yourself.');
  db.prepare('DELETE FROM meals WHERE user_id=?').run(id);
  db.prepare('DELETE FROM expenses WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  back(req, res, 'Member and their records deleted.');
});

app.post('/admin/meal', admin, (req, res) => {
  const uid = +req.body.user_id, day = req.body.day;
  const v = ['breakfast', 'lunch', 'dinner'].map(k => parseFloat(req.body[k]) || 0);
  if (!DAY.test(day) || !v.every(n => n >= 0 && n <= 10) || !db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))
    return back(req, res, 'Check the member, date and numbers.');
  saveMeal(uid, day, v);
  back(req, res, 'Meals saved.');
});

app.post('/admin/expense', admin, (req, res) => {
  const uid = +req.body.user_id, day = req.body.day, item = (req.body.item || '').trim(), amt = parseFloat(req.body.amount);
  if (!DAY.test(day) || !item || !(amt >= 0) || !db.prepare('SELECT 1 FROM users WHERE id=?').get(uid))
    return back(req, res, 'Check the member, date, item and amount.');
  db.prepare('INSERT INTO expenses(user_id,day,item,amount) VALUES(?,?,?,?)').run(uid, day, item, amt);
  back(req, res, 'Expense added.');
});

app.post('/admin/expense/:id/delete', admin, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  back(req, res, 'Expense deleted.');
});

app.post('/admin/clear', admin, (req, res) => {
  const m = req.body.month;
  if (!/^\d{4}-\d{2}$/.test(m || '')) return back(req, res);
  db.prepare('DELETE FROM meals WHERE day LIKE ?').run(m + '%');
  db.prepare('DELETE FROM expenses WHERE day LIKE ?').run(m + '%');
  back(req, res, 'All meals and expenses for ' + m + ' were deleted.');
});

app.get('/admin/backup', admin, (req, res) => res.download(DB_FILE, 'mess-backup.db'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log('Running on http://localhost:' + PORT));
