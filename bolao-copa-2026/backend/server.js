const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bolao-2026-dev-secret';

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('./bolao.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    is_verified INTEGER DEFAULT 0,
    verification_token TEXT,
    token_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    round INTEGER NOT NULL,
    team_a TEXT NOT NULL,
    team_b TEXT NOT NULL,
    team_a_flag TEXT NOT NULL,
    team_b_flag TEXT NOT NULL,
    match_date DATETIME NOT NULL,
    score_a INTEGER DEFAULT NULL,
    score_b INTEGER DEFAULT NULL,
    status TEXT DEFAULT 'scheduled',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    predicted_score_a INTEGER,
    predicted_score_b INTEGER,
    predicted_result TEXT,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (match_id) REFERENCES matches(id),
    UNIQUE(user_id, match_id)
  );
`);

// Migrate existing users table (safe — fails silently if column already exists)
['password_hash TEXT', 'is_verified INTEGER DEFAULT 0',
 'verification_token TEXT', 'token_expires DATETIME'].forEach(col => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (_) {}
});

// ── Email ─────────────────────────────────────────────────────────────────────
function getAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  return 'http://localhost:5000';
}

function createTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendVerificationEmail(email, name, token) {
  const url = `${getAppUrl()}/?verify=${token}`;
  const transporter = createTransporter();

  if (!transporter) {
    console.log(`\n📧 [DEV] Link de verificação para ${email}:\n   ${url}\n`);
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: '⚽ Confirme seu cadastro — Bolão Copa 2026',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#1e3c72">⚽ Bolão Copa 2026</h2>
        <p>Olá, <strong>${name}</strong>!</p>
        <p>Clique no botão abaixo para confirmar seu e-mail e acessar o bolão:</p>
        <a href="${url}"
           style="display:inline-block;background:#1e3c72;color:white;padding:14px 28px;
                  border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
          Confirmar E-mail
        </a>
        <p style="color:#666;font-size:13px">O link expira em 24 horas.<br>
           Se você não solicitou o cadastro, ignore este e-mail.</p>
      </div>`
  });
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  try {
    const payload = jwt.verify(header.split(' ')[1], JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────

// Register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
  if (password.length < 6)
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

  try {
    const existing = db.prepare('SELECT id, is_verified FROM users WHERE email = ?').get(email);
    if (existing && existing.is_verified)
      return res.status(400).json({ error: 'E-mail já cadastrado' });

    const passwordHash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    if (existing) {
      db.prepare(`UPDATE users SET name=?, password_hash=?, verification_token=?, token_expires=?, is_verified=0
                  WHERE id=?`).run(name, passwordHash, token, expires, existing.id);
    } else {
      db.prepare(`INSERT INTO users (name, email, password_hash, is_verified, verification_token, token_expires)
                  VALUES (?,?,?,0,?,?)`).run(name, email, passwordHash, token, expires);
    }

    await sendVerificationEmail(email, name, token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !user.password_hash)
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  if (!user.is_verified)
    return res.status(401).json({ error: 'E-mail não verificado. Confirme seu e-mail antes de entrar.', needsVerification: true });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid)
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// Verify email
app.get('/api/auth/verify/:token', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE verification_token = ?').get(req.params.token);
  if (!user) return res.status(400).json({ error: 'Link de verificação inválido' });
  if (new Date(user.token_expires) < new Date())
    return res.status(400).json({ error: 'Link de verificação expirado. Faça um novo cadastro.' });

  db.prepare('UPDATE users SET is_verified=1, verification_token=NULL, token_expires=NULL WHERE id=?').run(user.id);

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } });
});

// Me
app.get('/api/auth/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json(user);
});

// Resend verification
app.post('/api/auth/resend', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.is_verified)
    return res.status(400).json({ error: 'Usuário não encontrado ou já verificado' });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET verification_token=?, token_expires=? WHERE id=?').run(token, expires, user.id);

  await sendVerificationEmail(user.email, user.name, token);
  res.json({ success: true });
});

// ── App routes (require auth) ─────────────────────────────────────────────────

app.get('/api/users', authenticate, (req, res) => {
  const users = db.prepare('SELECT id, name, email FROM users WHERE is_verified=1 ORDER BY name').all();
  res.json(users);
});

app.get('/api/matches', authenticate, (req, res) => {
  const matches = db.prepare('SELECT * FROM matches ORDER BY group_name, round, match_date').all();
  res.json(matches);
});

app.get('/api/users/:userId/predictions', authenticate, (req, res) => {
  const predictions = db.prepare(`
    SELECT p.*, m.team_a, m.team_b, m.team_a_flag, m.team_b_flag, m.match_date, m.score_a, m.score_b, m.status
    FROM predictions p JOIN matches m ON p.match_id = m.id
    WHERE p.user_id = ? ORDER BY m.match_date
  `).all(req.params.userId);
  res.json(predictions);
});

app.post('/api/predictions', authenticate, (req, res) => {
  try {
    const { userId, matchId, predictedScoreA, predictedScoreB, predictedResult } = req.body;
    if (req.userId !== userId)
      return res.status(403).json({ error: 'Sem permissão' });

    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) return res.status(404).json({ error: 'Jogo não encontrado' });

    const now = new Date();
    const oneHourBefore = new Date(new Date(match.match_date).getTime() - 60 * 60 * 1000);
    if (now >= oneHourBefore)
      return res.status(400).json({ error: 'Palpites encerrados (menos de 1h para o jogo)' });

    const existing = db.prepare('SELECT * FROM predictions WHERE user_id=? AND match_id=?').get(userId, matchId);
    if (existing) {
      db.prepare(`UPDATE predictions SET predicted_score_a=?, predicted_score_b=?, predicted_result=?,
                  updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND match_id=?`)
        .run(predictedScoreA, predictedScoreB, predictedResult, userId, matchId);
    } else {
      db.prepare(`INSERT INTO predictions (user_id,match_id,predicted_score_a,predicted_score_b,predicted_result)
                  VALUES (?,?,?,?,?)`)
        .run(userId, matchId, predictedScoreA, predictedScoreB, predictedResult);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matches/update-scores', authenticate, (req, res) => {
  try {
    const update = db.prepare(`UPDATE matches SET score_a=?,score_b=?,status='finished',updated_at=CURRENT_TIMESTAMP WHERE id=?`);
    req.body.matches.forEach(({ id, scoreA, scoreB }) => update.run(scoreA, scoreB, id));
    calculatePoints();
    res.json({ success: true, message: `${req.body.matches.length} placares atualizados` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/matches/fetch-results', authenticate, async (req, res) => {
  try {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key não configurada' });

    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': apiKey }
    });
    const update = db.prepare(`UPDATE matches SET score_a=?,score_b=?,status='finished',updated_at=CURRENT_TIMESTAMP
                                WHERE team_a=? AND team_b=?`);
    let count = 0;
    response.data.matches.forEach(m => {
      if (m.status === 'FINISHED' && m.score.fullTime.home !== null) {
        update.run(m.score.fullTime.home, m.score.fullTime.away, m.homeTeam.name, m.awayTeam.name);
        count++;
      }
    });
    calculatePoints();
    res.json({ success: true, message: `${count} resultados atualizados` });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consumir API externa' });
  }
});

app.get('/api/ranking', authenticate, (req, res) => {
  const ranking = db.prepare(`
    SELECT u.id, u.name, u.email,
           COALESCE(SUM(p.points),0) as total_points,
           COUNT(p.id) as predictions_count
    FROM users u LEFT JOIN predictions p ON u.id = p.user_id
    WHERE u.is_verified = 1
    GROUP BY u.id ORDER BY total_points DESC, predictions_count ASC, u.name ASC
  `).all();
  res.json(ranking);
});

app.get('/api/matches/:matchId/predictions', authenticate, (req, res) => {
  const predictions = db.prepare(`
    SELECT u.name, p.predicted_score_a, p.predicted_score_b, p.predicted_result, p.points
    FROM predictions p JOIN users u ON p.user_id = u.id WHERE p.match_id=? ORDER BY p.points DESC
  `).all(req.params.matchId);
  res.json(predictions);
});

// ── Points calculation ────────────────────────────────────────────────────────
function calculatePoints() {
  const predictions = db.prepare(`
    SELECT p.*, m.score_a, m.score_b FROM predictions p JOIN matches m ON p.match_id=m.id
    WHERE m.status='finished' AND m.score_a IS NOT NULL
  `).all();

  const update = db.prepare('UPDATE predictions SET points=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  predictions.forEach(pred => {
    let points = 0;
    const actual = pred.score_a > pred.score_b ? 'A' : pred.score_b > pred.score_a ? 'B' : 'draw';
    if (pred.predicted_score_a === pred.score_a && pred.predicted_score_b === pred.score_b) points = 5;
    else if (pred.predicted_result === actual) points = 2;
    update.run(points, pred.id);
  });
}

// ── Match initialization ──────────────────────────────────────────────────────
function initializeMatches() {
  const count = db.prepare('SELECT COUNT(*) as count FROM matches').get().count;
  if (count > 0) return;

  const teams = {
    'México': '🇲🇽', 'Coreia do Sul': '🇰🇷', 'África do Sul': '🇿🇦', 'Tchéquia': '🇨🇿',
    'Canadá': '🇨🇦', 'Suíça': '🇨🇭', 'Qatar': '🇶🇦', 'Bósnia e Herzegovina': '🇧🇦',
    'Brasil': '🇧🇷', 'Marrocos': '🇲🇦', 'Haiti': '🇭🇹', 'Escócia': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    'Estados Unidos': '🇺🇸', 'Paraguai': '🇵🇾', 'Austrália': '🇦🇺', 'Turquia': '🇹🇷',
    'Alemanha': '🇩🇪', 'Curaçao': '🇨🇼', 'Costa do Marfim': '🇨🇮', 'Equador': '🇪🇨',
    'Holanda': '🇳🇱', 'Japão': '🇯🇵', 'Suécia': '🇸🇪', 'Tunísia': '🇹🇳',
    'Bélgica': '🇧🇪', 'Egito': '🇪🇬', 'Irã': '🇮🇷', 'Nova Zelândia': '🇳🇿',
    'Espanha': '🇪🇸', 'Cabo Verde': '🇨🇻', 'Arábia Saudita': '🇸🇦', 'Uruguai': '🇺🇾',
    'França': '🇫🇷', 'Senegal': '🇸🇳', 'Iraque': '🇮🇶', 'Noruega': '🇳🇴',
    'Argentina': '🇦🇷', 'Argélia': '🇩🇿', 'Áustria': '🇦🇹', 'Jordânia': '🇯🇴',
    'Portugal': '🇵🇹', 'Congo DR': '🇨🇩', 'Uzbequistão': '🇺🇿', 'Colômbia': '🇨🇴',
    'Inglaterra': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Croácia': '🇭🇷', 'Gana': '🇬🇭', 'Panamá': '🇵🇦'
  };

  const fixtures = [
    ['Grupo A', 1, 'México',        'África do Sul',       '2026-06-11T16:00:00-03:00'],
    ['Grupo A', 1, 'Coreia do Sul', 'Tchéquia',            '2026-06-11T23:00:00-03:00'],
    ['Grupo A', 2, 'Tchéquia',      'África do Sul',       '2026-06-18T13:00:00-03:00'],
    ['Grupo A', 2, 'México',        'Coreia do Sul',       '2026-06-18T22:00:00-03:00'],
    ['Grupo A', 3, 'México',        'Tchéquia',            '2026-06-24T22:00:00-03:00'],
    ['Grupo A', 3, 'Coreia do Sul', 'África do Sul',       '2026-06-24T22:00:00-03:00'],
    ['Grupo B', 1, 'Canadá',              'Bósnia e Herzegovina', '2026-06-12T16:00:00-03:00'],
    ['Grupo B', 1, 'Qatar',               'Suíça',               '2026-06-13T19:00:00-03:00'],
    ['Grupo B', 2, 'Canadá',              'Qatar',               '2026-06-19T19:00:00-03:00'],
    ['Grupo B', 2, 'Bósnia e Herzegovina','Suíça',               '2026-06-20T16:00:00-03:00'],
    ['Grupo B', 3, 'Suíça',              'Canadá',              '2026-06-25T20:30:00-03:00'],
    ['Grupo B', 3, 'Bósnia e Herzegovina','Qatar',               '2026-06-25T20:30:00-03:00'],
    ['Grupo C', 1, 'Brasil',   'Marrocos', '2026-06-13T19:00:00-03:00'],
    ['Grupo C', 1, 'Haiti',    'Escócia',  '2026-06-16T13:00:00-03:00'],
    ['Grupo C', 2, 'Brasil',   'Haiti',    '2026-06-19T22:00:00-03:00'],
    ['Grupo C', 2, 'Marrocos', 'Escócia',  '2026-06-19T16:00:00-03:00'],
    ['Grupo C', 3, 'Brasil',   'Escócia',  '2026-06-24T19:00:00-03:00'],
    ['Grupo C', 3, 'Marrocos', 'Haiti',    '2026-06-24T19:00:00-03:00'],
    ['Grupo D', 1, 'Estados Unidos', 'Paraguai',  '2026-06-12T22:00:00-03:00'],
    ['Grupo D', 1, 'Austrália',      'Turquia',   '2026-06-13T22:00:00-03:00'],
    ['Grupo D', 2, 'Estados Unidos', 'Austrália', '2026-06-20T13:00:00-03:00'],
    ['Grupo D', 2, 'Paraguai',       'Turquia',   '2026-06-20T19:00:00-03:00'],
    ['Grupo D', 3, 'Estados Unidos', 'Turquia',   '2026-06-25T22:00:00-03:00'],
    ['Grupo D', 3, 'Paraguai',       'Austrália', '2026-06-25T22:00:00-03:00'],
    ['Grupo E', 1, 'Alemanha',       'Curaçao',         '2026-06-14T14:00:00-03:00'],
    ['Grupo E', 1, 'Costa do Marfim','Equador',         '2026-06-14T20:00:00-03:00'],
    ['Grupo E', 2, 'Alemanha',       'Costa do Marfim', '2026-06-20T22:00:00-03:00'],
    ['Grupo E', 2, 'Curaçao',        'Equador',         '2026-06-21T13:00:00-03:00'],
    ['Grupo E', 3, 'Alemanha',       'Equador',         '2026-06-26T16:00:00-03:00'],
    ['Grupo E', 3, 'Curaçao',        'Costa do Marfim', '2026-06-26T16:00:00-03:00'],
    ['Grupo F', 1, 'Holanda', 'Japão',   '2026-06-14T17:00:00-03:00'],
    ['Grupo F', 1, 'Suécia',  'Tunísia', '2026-06-14T23:00:00-03:00'],
    ['Grupo F', 2, 'Holanda', 'Suécia',  '2026-06-21T19:00:00-03:00'],
    ['Grupo F', 2, 'Tunísia', 'Japão',   '2026-06-21T01:00:00-03:00'],
    ['Grupo F', 3, 'Holanda', 'Tunísia', '2026-06-26T20:30:00-03:00'],
    ['Grupo F', 3, 'Japão',   'Suécia',  '2026-06-26T20:30:00-03:00'],
    ['Grupo G', 1, 'Bélgica',       'Egito',         '2026-06-15T16:00:00-03:00'],
    ['Grupo G', 1, 'Irã',           'Nova Zelândia', '2026-06-15T22:00:00-03:00'],
    ['Grupo G', 2, 'Bélgica',       'Irã',           '2026-06-21T16:00:00-03:00'],
    ['Grupo G', 2, 'Egito',         'Nova Zelândia', '2026-06-22T13:00:00-03:00'],
    ['Grupo G', 3, 'Bélgica',       'Nova Zelândia', '2026-06-26T22:00:00-03:00'],
    ['Grupo G', 3, 'Egito',         'Irã',           '2026-06-26T22:00:00-03:00'],
    ['Grupo H', 1, 'Espanha',       'Cabo Verde',    '2026-06-15T13:00:00-03:00'],
    ['Grupo H', 1, 'Arábia Saudita','Uruguai',       '2026-06-15T19:00:00-03:00'],
    ['Grupo H', 2, 'Espanha',       'Arábia Saudita','2026-06-21T13:00:00-03:00'],
    ['Grupo H', 2, 'Cabo Verde',    'Uruguai',       '2026-06-22T19:00:00-03:00'],
    ['Grupo H', 3, 'Espanha',       'Uruguai',       '2026-06-27T13:00:00-03:00'],
    ['Grupo H', 3, 'Cabo Verde',    'Arábia Saudita','2026-06-27T13:00:00-03:00'],
    ['Grupo I', 1, 'França',   'Senegal', '2026-06-16T19:00:00-03:00'],
    ['Grupo I', 1, 'Iraque',   'Noruega', '2026-06-16T22:00:00-03:00'],
    ['Grupo I', 2, 'França',   'Iraque',  '2026-06-22T16:00:00-03:00'],
    ['Grupo I', 2, 'Senegal',  'Noruega', '2026-06-22T22:00:00-03:00'],
    ['Grupo I', 3, 'França',   'Noruega', '2026-06-27T16:00:00-03:00'],
    ['Grupo I', 3, 'Senegal',  'Iraque',  '2026-06-27T16:00:00-03:00'],
    ['Grupo J', 1, 'Argentina', 'Jordânia', '2026-06-17T22:00:00-03:00'],
    ['Grupo J', 1, 'Argélia',   'Áustria',  '2026-06-17T13:00:00-03:00'],
    ['Grupo J', 2, 'Argentina', 'Áustria',  '2026-06-23T22:00:00-03:00'],
    ['Grupo J', 2, 'Argélia',   'Jordânia', '2026-06-22T22:00:00-03:00'],
    ['Grupo J', 3, 'Argentina', 'Argélia',  '2026-06-27T20:30:00-03:00'],
    ['Grupo J', 3, 'Áustria',   'Jordânia', '2026-06-27T20:30:00-03:00'],
    ['Grupo K', 1, 'Portugal',   'Congo DR',    '2026-06-17T16:00:00-03:00'],
    ['Grupo K', 1, 'Colômbia',   'Uzbequistão', '2026-06-17T19:00:00-03:00'],
    ['Grupo K', 2, 'Portugal',   'Uzbequistão', '2026-06-23T16:00:00-03:00'],
    ['Grupo K', 2, 'Colômbia',   'Congo DR',    '2026-06-23T13:00:00-03:00'],
    ['Grupo K', 3, 'Portugal',   'Colômbia',    '2026-06-27T22:00:00-03:00'],
    ['Grupo K', 3, 'Congo DR',   'Uzbequistão', '2026-06-27T22:00:00-03:00'],
    ['Grupo L', 1, 'Inglaterra', 'Croácia', '2026-06-17T16:00:00-03:00'],
    ['Grupo L', 1, 'Gana',       'Panamá',  '2026-06-16T16:00:00-03:00'],
    ['Grupo L', 2, 'Inglaterra', 'Gana',    '2026-06-23T19:00:00-03:00'],
    ['Grupo L', 2, 'Croácia',    'Panamá',  '2026-06-23T22:00:00-03:00'],
    ['Grupo L', 3, 'Inglaterra', 'Panamá',  '2026-06-27T20:30:00-03:00'],
    ['Grupo L', 3, 'Croácia',    'Gana',    '2026-06-27T20:30:00-03:00'],
  ];

  const insert = db.prepare(`INSERT INTO matches (group_name,round,team_a,team_b,team_a_flag,team_b_flag,match_date)
                              VALUES (?,?,?,?,?,?,?)`);
  fixtures.forEach(([g, r, a, b, d]) => insert.run(g, r, a, b, teams[a] || '🏳️', teams[b] || '🏳️', d));
  console.log(`${fixtures.length} jogos inicializados com sucesso!`);
}

// ── Cron: auto-update scores every 6h ────────────────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return;
  try {
    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': apiKey }
    });
    const update = db.prepare(`UPDATE matches SET score_a=?,score_b=?,status='finished',updated_at=CURRENT_TIMESTAMP WHERE team_a=? AND team_b=?`);
    response.data.matches.forEach(m => {
      if (m.status === 'FINISHED' && m.score.fullTime.home !== null)
        update.run(m.score.fullTime.home, m.score.fullTime.away, m.homeTeam.name, m.awayTeam.name);
    });
    calculatePoints();
  } catch (err) {
    console.error('Erro na atualização automática:', err.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  initializeMatches();
});
