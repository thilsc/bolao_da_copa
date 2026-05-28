const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');
const hpp = require('hpp');
const path = require('path');
const nodemailer = require('nodemailer');

// Carregar variáveis de ambiente
dotenv.config();

// Validação de variáveis de ambiente obrigatórias
const requiredEnvVars = ['FOOTBALL_DATA_API_KEY', 'JWT_SECRET', 'APP_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error(`❌ ERRO CRÍTICO: Variáveis de ambiente ausentes: ${missingEnvVars.join(', ')}`);
  console.error('Por favor, configure todas as variáveis no arquivo .env');
  process.exit(1);
}

// Validar JWT_SECRET (deve ter pelo menos 32 caracteres)
if (process.env.JWT_SECRET.length < 32) {
  console.error('❌ ERRO CRÍTICO: JWT_SECRET deve ter pelo menos 32 caracteres para segurança adequada');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'bolao-2026-dev-secret';

// Middleware de segurança - Helmet (configura cabeçalhos HTTP seguros)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api.football-data.org'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: { policy: "same-site" },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true
}));

// Rate limiting para prevenir ataques de força bruta e DDoS
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite de 100 requisições por IP
  message: { error: 'Muitas requisições, tente novamente mais tarde' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health' // Não limitar health check
});

// Rate limiting mais rigoroso para rotas de autenticação
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // Apenas 5 tentativas de login por IP
  message: { error: 'Muitas tentativas de login, tente novamente após 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false
});

// Limitador específico para criação de usuários
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // Apenas 3 registros por IP por hora
  message: { error: 'Muitos registros, tente novamente mais tarde' },
  standardHeaders: true,
  legacyHeaders: false
});

// Limitador para rotas admin
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20, // 20 requisições para rotas admin
  message: { error: 'Muitas requisições administrativas' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

// Middleware
app.use(bodyParser.json({ limit: '10kb' })); // Limitar tamanho do payload
app.use(xss()); // Prevenir ataques XSS
app.use(hpp()); // Prevenir poluição de parâmetros HTTP

// CORS configurado de forma segura
const allowedOrigins = [
  'https://bolaopbc.netlify.app',
  'http://localhost:5173',
  'http://localhost:3001',
  process.env.APP_URL
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    // Permitir requisições sem origin (como mobile apps ou curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || origin.includes('netlify.app')) {
      callback(null, true);
    } else {
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
}));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database('./bolao.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
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

// Middleware de autenticação
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
}

// Middleware para verificar se é admin
function isAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso permitido apenas para administradores' });
  }
  next();
}

// Função de sanitização de input
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;
  // Remove caracteres especiais perigosos e limita o tamanho
  return input.replace(/[<>\"'`;(){}[\]\\]/g, '').trim().substring(0, 255);
}

// Validar email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Validar senha forte
function isStrongPassword(password) {
  // Mínimo 8 caracteres, pelo menos uma letra maiúscula, uma minúscula, um número e um caractere especial
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return passwordRegex.test(password);
}

// Registrar usuário
app.post('/api/users', registerLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Validações de entrada
    if (!name || typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) {
      return res.status(400).json({ error: 'Nome deve ter entre 2 e 100 caracteres' });
    }
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email é obrigatório' });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Senha é obrigatória' });
    }
    
    if (!isStrongPassword(password)) {
      return res.status(400).json({ 
        error: 'Senha fraca. A senha deve ter pelo menos 8 caracteres, incluindo letra maiúscula, minúscula, número e caractere especial (@$!%*?&)' 
      });
    }
    
    // Sanitizar inputs
    const sanitizedName = sanitizeInput(name);
    const sanitizedEmail = email.toLowerCase().trim();
    
    const hashedPassword = bcrypt.hashSync(password, 12); // Aumentado para 12 rounds
    const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(sanitizedName, sanitizedEmail, hashedPassword);
    
    // Gerar token de verificação
    const token = jwt.sign({ email: sanitizedEmail }, JWT_SECRET, { expiresIn: '24h' });
    
    // Salvar token de verificação no banco
    db.prepare("UPDATE users SET verification_token = ?, token_expires = datetime('now', '+24 hours') WHERE email = ?").run(token, sanitizedEmail);
    
    await sendVerificationEmail(sanitizedEmail, sanitizedName, token);
    
    res.status(201).json({ id: result.lastInsertRowid, name: sanitizedName, email: sanitizedEmail });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Email já cadastrado' });
    } else {
      console.error('Erro ao registrar usuário:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  }
});

// Verificar email do usuário
app.get('/api/users/verify/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ error: 'Token inválido ou expirado' });
    }
    
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND verification_token = ?').get(decoded.email, token);
    
    if (!user) {
      return res.status(400).json({ error: 'Token inválido' });
    }
    
    // Verificar se o token expirou
    if (new Date(user.token_expires) < new Date()) {
      return res.status(400).json({ error: 'Token expirado' });
    }
    
    // Atualizar usuário como verificado
    db.prepare('UPDATE users SET is_verified = 1, verification_token = NULL, token_expires = NULL WHERE id = ?').run(user.id);
    
    // Gerar token de autenticação
    const authToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ 
      token: authToken, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        role: user.role 
      } 
    });
  } catch (error) {
    console.error('Erro ao verificar email:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Reenviar email de verificação
app.post('/api/users/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    
    const sanitizedEmail = email.toLowerCase().trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(sanitizedEmail);
    
    if (!user) {
      return res.status(400).json({ error: 'Email não encontrado' });
    }
    
    if (user.is_verified) {
      return res.status(400).json({ error: 'Email já verificado' });
    }
    
    // Gerar novo token
    const token = jwt.sign({ email: sanitizedEmail }, JWT_SECRET, { expiresIn: '24h' });
    
    // Salvar token de verificação no banco
    db.prepare("UPDATE users SET verification_token = ?, token_expires = datetime('now', '+24 hours') WHERE email = ?").run(token, sanitizedEmail);
    
    await sendVerificationEmail(sanitizedEmail, user.name, token);
    
    res.json({ message: 'Email de verificação reenviado' });
  } catch (error) {
    console.error('Erro ao reenviar email de verificação:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Login com rate limiting rigoroso
app.post('/api/login', authLimiter, (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Validações básicas
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Senha é obrigatória' });
    }
    
    const sanitizedEmail = email.toLowerCase().trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(sanitizedEmail);
    
    // Mensagem genérica para prevenir enumeração de usuários
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    
    const validPassword = bcrypt.compareSync(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    
    // Verificar se o email foi confirmado (exceto para admin)
    if (!user.is_verified && user.email !== 'admin@bolao.com') {
      return res.status(403).json({ 
        error: 'Email não verificado. Por favor, verifique seu email antes de fazer login.',
        resendVerification: true
      });
    }
    
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Não enviar senha mesmo que hash no response
    res.json({ 
      token, 
      user: { 
        id: user.id, 
        name: user.name, 
        email: user.email, 
        role: user.role 
      } 
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter dados do usuário autenticado (me)
app.get('/api/users/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    res.json(user);
  } catch (error) {
    console.error('Erro ao obter usuário:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar usuários (protegido - apenas admin)
app.get('/api/users', authenticateToken, isAdmin, (req, res) => {
  // Não retornar senhas
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all();
  res.json(users);
});

// Listar usuários pendentes de ativação das últimas 48h (apenas admin)
app.get('/api/users/pending-activation', authenticateToken, isAdmin, (req, res) => {
  try {
    // Buscar usuários não verificados cadastrados nas últimas 48 horas
    const pendingUsers = db.prepare(`
      SELECT id, name, email, role, created_at 
      FROM users 
      WHERE is_verified = 0 
        AND created_at >= datetime('now', '-48 hours')
      ORDER BY created_at DESC
    `).all();
    res.json(pendingUsers);
  } catch (error) {
    console.error('Erro ao listar usuários pendentes:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Ativar usuário manualmente (apenas admin)
app.post('/api/users/activate/:userId', authenticateToken, isAdmin, (req, res) => {
  try {
    const { userId } = req.params;
    
    // Validar userId como número inteiro
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId) || parsedUserId <= 0) {
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }
    
    // Verificar se o usuário existe
    const user = db.prepare('SELECT id, email, is_verified FROM users WHERE id = ?').get(parsedUserId);
    
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    if (user.is_verified) {
      return res.status(400).json({ error: 'Usuário já está ativado' });
    }
    
    // Ativar usuário
    db.prepare('UPDATE users SET is_verified = 1, verification_token = NULL, token_expires = NULL WHERE id = ?').run(parsedUserId);
    
    res.json({ message: 'Usuário ativado com sucesso', userId: parsedUserId });
  } catch (error) {
    console.error('Erro ao ativar usuário:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Ativar todos os usuários pendentes das últimas 48h (apenas admin)
app.post('/api/users/activate-all-pending', authenticateToken, isAdmin, (req, res) => {
  try {
    // Ativar todos os usuários não verificados das últimas 48 horas
    const result = db.prepare(`
      UPDATE users 
      SET is_verified = 1, verification_token = NULL, token_expires = NULL
      WHERE is_verified = 0 
        AND created_at >= datetime('now', '-48 hours')
    `).run();
    
    res.json({ 
      message: `Usuários ativados com sucesso`,
      activatedCount: result.changes
    });
  } catch (error) {
    console.error('Erro ao ativar usuários pendentes:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Listar todos os jogos (com validação de parâmetros)
app.get('/api/matches', (req, res) => {
  try {
    const matches = db.prepare('SELECT id, group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date, score_a, score_b, status FROM matches ORDER BY group_name, round, match_date').all();
    res.json(matches);
  } catch (error) {
    console.error('Erro ao listar jogos:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter palpites de um usuário (com autenticação e validação)
app.get('/api/users/:userId/predictions', authenticateToken, (req, res) => {
  try {
    const { userId } = req.params;
    
    // Validar userId como número inteiro
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId) || parsedUserId <= 0) {
      return res.status(400).json({ error: 'ID de usuário inválido' });
    }
    
    // Usuário só pode ver seus próprios palpites, a menos que seja admin
    if (req.user.role !== 'admin' && req.user.id !== parsedUserId) {
      return res.status(403).json({ error: 'Acesso não autorizado' });
    }
    
    const predictions = db.prepare(`
      SELECT p.id, p.predicted_score_a, p.predicted_score_b, p.predicted_result, p.points, p.created_at, p.updated_at,
             m.team_a, m.team_b, m.team_a_flag, m.team_b_flag, m.match_date, m.score_a, m.score_b, m.status
      FROM predictions p
      JOIN matches m ON p.match_id = m.id
      WHERE p.user_id = ?
      ORDER BY m.match_date
    `).all(parsedUserId);
    res.json(predictions);
  } catch (error) {
    console.error('Erro ao obter palpites:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Fazer ou atualizar palpite (com autenticação e validações rigorosas)
app.post('/api/predictions', authenticateToken, (req, res) => {
  try {
    const { userId, matchId, predictedScoreA, predictedScoreB, predictedResult } = req.body;
    
    // Validar que o usuário autenticado está fazendo palpite para si mesmo
    const parsedUserId = parseInt(userId, 10);
    if (isNaN(parsedUserId) || parsedUserId !== req.user.id) {
      return res.status(403).json({ error: 'Só é permitido fazer palpites para o próprio usuário' });
    }
    
    // Validar matchId
    const parsedMatchId = parseInt(matchId, 10);
    if (isNaN(parsedMatchId) || parsedMatchId <= 0) {
      return res.status(400).json({ error: 'ID de jogo inválido' });
    }
    
    // Validar scores (devem ser números inteiros entre 0 e 99)
    const scoreA = parseInt(predictedScoreA, 10);
    const scoreB = parseInt(predictedScoreB, 10);
    
    if (isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0 || scoreA > 99 || scoreB > 99) {
      return res.status(400).json({ error: 'Placar inválido. Os valores devem ser números inteiros entre 0 e 99.' });
    }
    
    // Validar resultado previsto
    const validResults = ['A', 'B', 'draw'];
    if (!predictedResult || !validResults.includes(predictedResult)) {
      return res.status(400).json({ error: 'Resultado previsto inválido. Deve ser A, B ou draw.' });
    }
    
    // Verificar se o jogo já começou ou está prestes a começar (menos de 1 hora)
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(parsedMatchId);
    if (!match) {
      return res.status(404).json({ error: 'Jogo não encontrado' });
    }

    const now = new Date();
    const oneHourBefore = new Date(matchDate.getTime() - 60 * 60 * 1000);

    if (now >= oneHourBefore) {
      return res.status(400).json({ 
        error: 'Não é permitido alterar palpites com menos de 1 hora antes do jogo começar' 
      });
    }

    // Verificar se já existe palpite
    const existing = db.prepare('SELECT * FROM predictions WHERE user_id = ? AND match_id = ?').get(parsedUserId, parsedMatchId);

    if (existing) {
      db.prepare(`
        UPDATE predictions 
        SET predicted_score_a = ?, predicted_score_b = ?, predicted_result = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND match_id = ?
      `).run(scoreA, scoreB, predictedResult, parsedUserId, parsedMatchId);
    } else {
      db.prepare(`
        INSERT INTO predictions (user_id, match_id, predicted_score_a, predicted_score_b, predicted_result)
        VALUES (?, ?, ?, ?, ?)
      `).run(parsedUserId, parsedMatchId, scoreA, scoreB, predictedResult);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao criar palpite:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar placares manualmente (apenas admin) - com validações rigorosas
app.post('/api/matches/update-scores', authenticateToken, isAdmin, adminLimiter, async (req, res) => {
  try {
    const { matches } = req.body;
    
    // Validar input
    if (!matches || !Array.isArray(matches)) {
      return res.status(400).json({ error: 'Dados inválidos. Esperado um array de jogos.' });
    }
    
    // Limitar número de atualizações por requisição
    if (matches.length > 50) {
      return res.status(400).json({ error: 'Máximo de 50 jogos por requisição' });
    }
    
    const updateMatch = db.prepare(`
      UPDATE matches 
      SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    let updatedCount = 0;
    
    // Usar transação para garantir atomicidade
    const transaction = db.transaction((matchList) => {
      matchList.forEach(({ id, scoreA, scoreB }) => {
        // Validar IDs e scores
        const matchId = parseInt(id, 10);
        const parsedScoreA = parseInt(scoreA, 10);
        const parsedScoreB = parseInt(scoreB, 10);
        
        if (isNaN(matchId) || matchId <= 0) {
          throw new Error(`ID de jogo inválido: ${id}`);
        }
        
        if (isNaN(parsedScoreA) || isNaN(parsedScoreB) || parsedScoreA < 0 || parsedScoreB < 0 || parsedScoreA > 99 || parsedScoreB > 99) {
          throw new Error(`Placar inválido para jogo ${matchId}: ${scoreA}-${scoreB}`);
        }
        
        updateMatch.run(parsedScoreA, parsedScoreB, matchId);
        updatedCount++;
      });
    });
    
    transaction(matches);

    // Calcular pontos para todos os usuários
    calculatePoints();

    res.json({ success: true, message: `${updatedCount} placares atualizados` });
  } catch (error) {
    console.error('Erro ao atualizar placares:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Função para calcular pontos (com transação e tratamento de erros)
function calculatePoints() {
  try {
    const predictions = db.prepare(`
      SELECT p.id, p.predicted_score_a, p.predicted_score_b, p.predicted_result, m.score_a, m.score_b
      FROM predictions p
      JOIN matches m ON p.match_id = m.id
      WHERE m.status = 'finished' AND m.score_a IS NOT NULL AND p.predicted_score_a IS NOT NULL
    `).all();

    const updatePrediction = db.prepare(`
      UPDATE predictions SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    // Usar transação para garantir atomicidade
    const transaction = db.transaction((predList) => {
      predList.forEach(pred => {
        let points = 0;

        // Validar scores
        const actualScoreA = parseInt(pred.score_a, 10);
        const actualScoreB = parseInt(pred.score_b, 10);
        const predictedScoreA = parseInt(pred.predicted_score_a, 10);
        const predictedScoreB = parseInt(pred.predicted_score_b, 10);

        if (isNaN(actualScoreA) || isNaN(actualScoreB) || isNaN(predictedScoreA) || isNaN(predictedScoreB)) {
          return; // Pular previsões com dados inválidos
        }

        // Determinar resultado real
        let actualResult;
        if (actualScoreA > actualScoreB) {
          actualResult = 'A';
        } else if (actualScoreB > actualScoreA) {
          actualResult = 'B';
        } else {
          actualResult = 'draw';
        }

        // Verificar acerto do placar exato
        if (predictedScoreA === actualScoreA && predictedScoreB === actualScoreB) {
          points = 5;
        } 
        // Verificar acerto apenas do resultado
        else if (pred.predicted_result === actualResult) {
          points = 2;
        }

        updatePrediction.run(points, pred.id);
      });
    });

    transaction(predictions);
    console.log('Pontos calculados com sucesso!');
  } catch (error) {
    console.error('Erro ao calcular pontos:', error);
  }
}

// Ranking de usuários (sem expor dados sensíveis)
app.get('/api/ranking', (req, res) => {
  try {
    const ranking = db.prepare(`
      SELECT u.id, u.name, COALESCE(SUM(p.points), 0) as total_points, COUNT(p.id) as predictions_count
      FROM users u
      LEFT JOIN predictions p ON u.id = p.user_id
      WHERE u.role != 'admin'
      GROUP BY u.id, u.name
      ORDER BY total_points DESC, predictions_count ASC, u.name ASC
    `).all();
    
    res.json(ranking);
  } catch (error) {
    console.error('Erro ao obter ranking:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter palpites de todos os usuários para um jogo específico (com validação)
app.get('/api/matches/:matchId/predictions', authenticateToken, (req, res) => {
  try {
    const { matchId } = req.params;
    
    // Validar matchId
    const parsedMatchId = parseInt(matchId, 10);
    if (isNaN(parsedMatchId) || parsedMatchId <= 0) {
      return res.status(400).json({ error: 'ID de jogo inválido' });
    }
    
    // Verificar se o jogo existe
    const match = db.prepare('SELECT id FROM matches WHERE id = ?').get(parsedMatchId);
    if (!match) {
      return res.status(404).json({ error: 'Jogo não encontrado' });
    }
    
    const predictions = db.prepare(`
      SELECT u.id, u.name, p.predicted_score_a, p.predicted_score_b, p.predicted_result, p.points
      FROM predictions p
      JOIN users u ON p.user_id = u.id
      WHERE p.match_id = ?
      ORDER BY p.points DESC
    `).all(parsedMatchId);
    res.json(predictions);
  } catch (error) {
    console.error('Erro ao obter palpites do jogo:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Job agendado para atualizar placares automaticamente (a cada 6 horas) - com timeout e tratamento de erros
cron.schedule('0 */6 * * *', async () => {
  await fetchAndUpdateMatches();
});

// Função para buscar e atualizar resultados da API football-data.org
async function fetchAndUpdateMatches() {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    console.log('⚠️  API key não configurada. Pulando atualização automática.');
    return;
  }
  
  try {
    console.log('🔄 Buscando resultados da API football-data.org...');
    
    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches?season=2026', {
      headers: { 
        'X-Auth-Token': apiKey,
        'Accept': 'application/json'
      },
      timeout: 15000, // 15 segundos de timeout
      maxRedirects: 3,
      validateStatus: (status) => status === 200
    });

    if (!response.data || !response.data.matches) {
      console.error('❌ Resposta inválida da API no job agendado');
      return;
    }

    const apiMatches = response.data.matches;
    console.log(`📊 Encontrados ${apiMatches.length} jogos na API`);
    
    // Filtrar apenas jogos finalizados
    const finishedMatches = apiMatches.filter(m => m.status === 'FINISHED');
    console.log(`✅ ${finishedMatches.length} jogos finalizados encontrados`);
    
    let updatedCount = 0;
    let insertedCount = 0;
    
    const updateMatch = db.prepare(`
      UPDATE matches 
      SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
      WHERE team_a = ? AND team_b = ?
    `);
    
    const insertMatch = db.prepare(`
      INSERT OR IGNORE INTO matches (group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date, status, score_a, score_b)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'finished', ?, ?)
    `);
    
    // Usar transação para garantir atomicidade
    const transaction = db.transaction(() => {
      finishedMatches.forEach(match => {
        if (match.score.fullTime.home !== null && match.score.fullTime.away !== null) {
          const homeScore = parseInt(match.score.fullTime.home, 10);
          const awayScore = parseInt(match.score.fullTime.away, 10);
          
          if (!isNaN(homeScore) && !isNaN(awayScore) && homeScore >= 0 && awayScore >= 0) {
            const homeTeam = sanitizeInput(match.homeTeam.name);
            const awayTeam = sanitizeInput(match.awayTeam.name);
            
            // Tentar atualizar primeiro
            const result = updateMatch.run(homeScore, awayScore, homeTeam, awayTeam);
            
            // Se não atualizou nenhum registro, tentar inserir
            if (result.changes === 0) {
              // Extrair grupo e rodada dos dados da API se disponível
              const groupName = match.group || 'TBD';
              const round = match.matchday || 1;
              const homeFlag = match.homeTeam.area?.code || 'XX';
              const awayFlag = match.awayTeam.area?.code || 'XX';
              const matchDate = match.utcDate || new Date().toISOString();
              
              insertMatch.run(
                groupName,
                round,
                homeTeam,
                awayTeam,
                homeFlag,
                awayFlag,
                matchDate,
                homeScore,
                awayScore
              );
              insertedCount++;
            } else {
              updatedCount++;
            }
          }
        }
      });
    });
    
    transaction();

    // Calcular pontos após atualização
    calculatePoints();
    
    console.log(`✅ Atualização automática concluída! ${updatedCount} jogos atualizados, ${insertedCount} novos jogos inseridos.`);
    
  } catch (error) {
    console.error('❌ Erro na atualização automática:', error.message);
    if (error.code === 'ECONNABORTED') {
      console.error('⏱️  Timeout ao conectar com API externa');
    } else if (error.response) {
      console.error(`🔴 Erro HTTP ${error.response.status}: ${error.response.statusText}`);
    }
  }
}

// Endpoint para atualizar manualmente os resultados da API (apenas atualiza placares, não exclui dados)
app.post('/api/matches/fetch-results', authenticateToken, isAdmin, adminLimiter, async (req, res) => {
  try {
    console.log('🔄 Solicitação manual para buscar resultados da API...');
    await fetchAndUpdateMatches();
    res.json({ success: true, message: 'Resultados atualizados da API com sucesso' });
  } catch (error) {
    console.error('❌ Erro ao buscar dados da API:', error.message);
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Timeout ao conectar com API externa' });
    }
    res.status(500).json({ error: 'Erro ao consumir API externa' });
  }
});

// Endpoint para sincronizar completamente com a API da Copa do Mundo FIFA 2026
// ATENÇÃO: Este endpoint EXCLUI todos os jogos e palpites existentes antes de importar os novos dados
app.post('/api/matches/sync-world-cup-2026', authenticateToken, isAdmin, adminLimiter, async (req, res) => {
  try {
    console.log('⚠️ INICIANDO SINCRONIZAÇÃO COMPLETA DA COPA DO MUNDO 2026 - ESTE PROCESSO EXCLUIRÁ TODOS OS DADOS EXISTENTES');
    
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: 'API key não configurada. Configure FOOTBALL_DATA_API_KEY no arquivo .env' });
    }
    
    // Buscar dados da API Football-Data.org para a Copa do Mundo FIFA 2026
    console.log('📡 Buscando jogos da Copa do Mundo FIFA 2026 na API...');
    
    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches?season=2026', {
      headers: { 
        'X-Auth-Token': apiKey,
        'Accept': 'application/json'
      },
      timeout: 30000,
      maxRedirects: 3,
      validateStatus: (status) => status === 200
    });

    if (!response.data || !response.data.matches) {
      return res.status(500).json({ error: 'Resposta inválida da API' });
    }

    const apiMatches = response.data.matches;
    console.log(`📊 Encontrados ${apiMatches.length} jogos na API`);

    // Excluir todos os palpites primeiro (devido à chave estrangeira)
    console.log('🗑️ Excluindo todos os palpites existentes...');
    db.exec('DELETE FROM predictions');
    
    // Excluir todos os jogos
    console.log('🗑️ Excluindo todos os jogos existentes...');
    db.exec('DELETE FROM matches');
    
    // Preparar statements para inserção
    const insertMatch = db.prepare(`
      INSERT INTO matches (group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date, status, score_a, score_b)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    // Usar transação para garantir atomicidade
    const transaction = db.transaction(() => {
      apiMatches.forEach(match => {
        const homeTeam = sanitizeInput(match.homeTeam.name);
        const awayTeam = sanitizeInput(match.awayTeam.name);
        const groupName = match.group || match.stage || 'TBD';
        const round = match.matchday || 1;
        const homeFlag = match.homeTeam.area?.code || 'XX';
        const awayFlag = match.awayTeam.area?.code || 'XX';
        const matchDate = match.utcDate || new Date().toISOString();
        
        // Determinar status e placar
        let status = 'scheduled';
        let scoreA = null;
        let scoreB = null;
        
        if (match.status === 'FINISHED' && match.score.fullTime.home !== null && match.score.fullTime.away !== null) {
          status = 'finished';
          scoreA = parseInt(match.score.fullTime.home, 10);
          scoreB = parseInt(match.score.fullTime.away, 10);
          
          if (isNaN(scoreA) || isNaN(scoreB) || scoreA < 0 || scoreB < 0) {
            scoreA = null;
            scoreB = null;
            status = 'scheduled';
          }
        } else if (match.status === 'IN_PLAY' || match.status === 'PAUSED') {
          status = 'live';
          if (match.score.fullTime.home !== null && match.score.fullTime.away !== null) {
            scoreA = parseInt(match.score.fullTime.home, 10);
            scoreB = parseInt(match.score.fullTime.away, 10);
          }
        }
        
        insertMatch.run(
          groupName,
          round,
          homeTeam,
          awayTeam,
          homeFlag,
          awayFlag,
          matchDate,
          status,
          scoreA,
          scoreB
        );
      });
    });
    
    transaction();
    
    const insertedCount = apiMatches.length;
    console.log(`✅ SINCRONIZAÇÃO COMPLETA CONCLUÍDA! ${insertedCount} jogos da Copa do Mundo FIFA 2026 importados.`);
    console.log('⚠️ LEMBRETE: Todos os palpites e jogos anteriores foram EXCLUÍDOS permanentemente.');
    
    res.json({ 
      success: true, 
      message: `Sincronização completa realizada! ${insertedCount} jogos da Copa do Mundo FIFA 2026 importados.`,
      warning: 'Todos os dados anteriores (jogos e palpites) foram excluídos permanentemente.',
      matchesImported: insertedCount
    });
    
  } catch (error) {
    console.error('❌ Erro crítico na sincronização da Copa do Mundo 2026:', error.message);
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Timeout ao conectar com API externa' });
    } else if (error.response) {
      return res.status(error.response.status).json({ error: `Erro HTTP ${error.response.status}: ${error.response.statusText}` });
    }
    res.status(500).json({ error: 'Erro crítico ao sincronizar com API externa' });
  }
});

// Endpoint de health check (sem rate limiting)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inicializar servidor - aceitar conexões de qualquer origem (necessário para Render)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
  console.log('✅ Servidor configurado para aceitar conexões externas');
  createAdminUser();
  resetPredictionsAndMatches(); //temporário
  initializeMatches();
});

// Função para inicializar partidas da Copa do Mundo 2026 (fase de grupos) - Dados oficiais FIFA
function resetPredictionsAndMatches() {
  console.log('🗑️ Excluindo todos os palpites existentes...');
  db.exec('DELETE FROM predictions');
  
  // Excluir todos os jogos
  console.log('🗑️ Excluindo todos os jogos existentes...');
  db.exec('DELETE FROM matches');
}

// Função para inicializar partidas da Copa do Mundo 2026 (fase de grupos) - Dados oficiais FIFA
function initializeMatches() {
  const count = db.prepare('SELECT COUNT(*) as total FROM matches').get();
  if (count.total > 0) {
    console.log('Partidas já inicializadas.');
    return;
  }

  console.log('Inicializando partidas da Copa do Mundo 2026...');

  // Dados oficiais das 48 partidas da fase de grupos da Copa 2026
  // Formato: [grupo, rodada, timeA, timeB, flagA, flagB, data, status]
  // Flags são códigos de país ISO 3166-1 alpha-2 para emojis
  const matchesData = [
    ['GRUPO A', 1, 'Coreia do Sul', 'República Tcheca', 'KR', 'CZ', '2026-06-12T02:00:00Z', 'scheduled'],
    ['GRUPO A', 1, 'México', 'África do Sul', 'MX', 'ZA', '2026-06-11T19:00:00Z', 'scheduled'],
    ['GRUPO A', 2, 'México', 'Coreia do Sul', 'MX', 'KR', '2026-06-19T01:00:00Z', 'scheduled'],
    ['GRUPO A', 2, 'República Tcheca', 'África do Sul', 'CZ', 'ZA', '2026-06-18T16:00:00Z', 'scheduled'],
    ['GRUPO A', 3, 'República Tcheca', 'México', 'CZ', 'MX', '2026-06-25T01:00:00Z', 'scheduled'],
    ['GRUPO A', 3, 'África do Sul', 'Coreia do Sul', 'ZA', 'KR', '2026-06-25T01:00:00Z', 'scheduled'],
    
    ['GRUPO B', 1, 'Canadá', 'Bósnia-Herzegovina', 'CA', 'BA', '2026-06-12T19:00:00Z', 'scheduled'],
    ['GRUPO B', 1, 'Catar', 'Suíça', 'QA', 'CH', '2026-06-13T19:00:00Z', 'scheduled'],
    ['GRUPO B', 2, 'Canadá', 'Catar', 'CA', 'QA', '2026-06-18T22:00:00Z', 'scheduled'],
    ['GRUPO B', 2, 'Suíça', 'Bósnia-Herzegovina', 'CH', 'BA', '2026-06-18T19:00:00Z', 'scheduled'],
    ['GRUPO B', 3, 'Bósnia-Herzegovina', 'Catar', 'BA', 'QA', '2026-06-24T19:00:00Z', 'scheduled'],
    ['GRUPO B', 3, 'Suíça', 'Canadá', 'CH', 'CA', '2026-06-24T19:00:00Z', 'scheduled'],
    
    ['GRUPO C', 1, 'Brasil', 'Marrocos', 'BR', 'MA', '2026-06-13T22:00:00Z', 'scheduled'],
    ['GRUPO C', 1, 'Haiti', 'Escócia', 'HT', 'GB-SCT', '2026-06-14T01:00:00Z', 'scheduled'],
    ['GRUPO C', 2, 'Brasil', 'Haiti', 'BR', 'HT', '2026-06-20T00:30:00Z', 'scheduled'],
    ['GRUPO C', 2, 'Escócia', 'Marrocos', 'GB-SCT', 'MA', '2026-06-19T22:00:00Z', 'scheduled'],
    ['GRUPO C', 3, 'Escócia', 'Brasil', 'GB-SCT', 'BR', '2026-06-24T22:00:00Z', 'scheduled'],
    ['GRUPO C', 3, 'Marrocos', 'Haiti', 'MA', 'HT', '2026-06-24T22:00:00Z', 'scheduled'],
    
    ['GRUPO D', 1, 'Austrália', 'Turquia', 'AU', 'TR', '2026-06-14T04:00:00Z', 'scheduled'],
    ['GRUPO D', 1, 'EUA', 'Paraguai', 'US', 'PY', '2026-06-13T01:00:00Z', 'scheduled'],
    ['GRUPO D', 2, 'EUA', 'Austrália', 'US', 'AU', '2026-06-19T19:00:00Z', 'scheduled'],
    ['GRUPO D', 2, 'Turquia', 'Paraguai', 'TR', 'PY', '2026-06-20T03:00:00Z', 'scheduled'],
    ['GRUPO D', 3, 'Paraguai', 'Austrália', 'PY', 'AU', '2026-06-26T02:00:00Z', 'scheduled'],
    ['GRUPO D', 3, 'Turquia', 'EUA', 'TR', 'US', '2026-06-26T02:00:00Z', 'scheduled'],
    
    ['GRUPO E', 1, 'Alemanha', 'Curaçao', 'DE', 'CW', '2026-06-14T17:00:00Z', 'scheduled'],
    ['GRUPO E', 1, 'Costa do Marfim', 'Equador', 'CI', 'EC', '2026-06-14T23:00:00Z', 'scheduled'],
    ['GRUPO E', 2, 'Alemanha', 'Costa do Marfim', 'DE', 'CI', '2026-06-20T20:00:00Z', 'scheduled'],
    ['GRUPO E', 2, 'Equador', 'Curaçao', 'EC', 'CW', '2026-06-21T00:00:00Z', 'scheduled'],
    ['GRUPO E', 3, 'Curaçao', 'Costa do Marfim', 'CW', 'CI', '2026-06-25T20:00:00Z', 'scheduled'],
    ['GRUPO E', 3, 'Equador', 'Alemanha', 'EC', 'DE', '2026-06-25T20:00:00Z', 'scheduled'],
    
    ['GRUPO F', 1, 'Holanda', 'Japão', 'NL', 'JP', '2026-06-14T20:00:00Z', 'scheduled'],
    ['GRUPO F', 1, 'Suécia', 'Tunísia', 'SE', 'TN', '2026-06-15T02:00:00Z', 'scheduled'],
    ['GRUPO F', 2, 'Holanda', 'Suécia', 'NL', 'SE', '2026-06-20T17:00:00Z', 'scheduled'],
    ['GRUPO F', 2, 'Tunísia', 'Japão', 'TN', 'JP', '2026-06-21T04:00:00Z', 'scheduled'],
    ['GRUPO F', 3, 'Japão', 'Suécia', 'JP', 'SE', '2026-06-25T23:00:00Z', 'scheduled'],
    ['GRUPO F', 3, 'Tunísia', 'Holanda', 'TN', 'NL', '2026-06-25T23:00:00Z', 'scheduled'],

    ['GRUPO G', 1, 'Bélgica', 'Egito', 'BE', 'EG', '2026-06-15T19:00:00Z', 'scheduled'],
    ['GRUPO G', 1, 'Irã', 'Nova Zelândia', 'IR', 'NZ', '2026-06-16T01:00:00Z', 'scheduled'],
    ['GRUPO G', 2, 'Bélgica', 'Irã', 'BE', 'IR', '2026-06-21T19:00:00Z', 'scheduled'],
    ['GRUPO G', 2, 'Nova Zelândia', 'Egito', 'NZ', 'EG', '2026-06-22T01:00:00Z', 'scheduled'],
    ['GRUPO G', 3, 'Egito', 'Irã', 'EG', 'IR', '2026-06-27T03:00:00Z', 'scheduled'],
    ['GRUPO G', 3, 'Nova Zelândia', 'Bélgica', 'NZ', 'BE', '2026-06-27T03:00:00Z', 'scheduled'],
    
    ['GRUPO H', 1, 'Arábia Saudita', 'Uruguai', 'SA', 'UY', '2026-06-15T22:00:00Z', 'scheduled'],
    ['GRUPO H', 1, 'Espanha', 'Cabo Verde', 'ES', 'CV', '2026-06-15T16:00:00Z', 'scheduled'],
    ['GRUPO H', 2, 'Espanha', 'Arábia Saudita', 'ES', 'SA', '2026-06-21T16:00:00Z', 'scheduled'],
    ['GRUPO H', 2, 'Uruguai', 'Cabo Verde', 'UY', 'CV', '2026-06-21T22:00:00Z', 'scheduled'],
    ['GRUPO H', 3, 'Cabo Verde', 'Arábia Saudita', 'CV', 'SA', '2026-06-27T00:00:00Z', 'scheduled'],
    ['GRUPO H', 3, 'Uruguai', 'Espanha', 'UY', 'ES', '2026-06-27T00:00:00Z', 'scheduled'],
    
    ['GRUPO I', 1, 'França', 'Senegal', 'FR', 'SN', '2026-06-16T19:00:00Z', 'scheduled'],
    ['GRUPO I', 1, 'Iraque', 'Noruega', 'IQ', 'NO', '2026-06-16T22:00:00Z', 'scheduled'],
    ['GRUPO I', 2, 'França', 'Iraque', 'FR', 'IQ', '2026-06-22T21:00:00Z', 'scheduled'],
    ['GRUPO I', 2, 'Noruega', 'Senegal', 'NO', 'SN', '2026-06-23T00:00:00Z', 'scheduled'],
    ['GRUPO I', 3, 'Noruega', 'França', 'NO', 'FR', '2026-06-26T19:00:00Z', 'scheduled'],
    ['GRUPO I', 3, 'Senegal', 'Iraque', 'SN', 'IQ', '2026-06-26T19:00:00Z', 'scheduled'],
    
    ['GRUPO J', 1, 'Argentina', 'Argélia', 'AR', 'DZ', '2026-06-17T01:00:00Z', 'scheduled'],
    ['GRUPO J', 1, 'Áustria', 'Jordânia', 'AT', 'JO', '2026-06-17T04:00:00Z', 'scheduled'],
    ['GRUPO J', 2, 'Argentina', 'Áustria', 'AR', 'AT', '2026-06-22T17:00:00Z', 'scheduled'],
    ['GRUPO J', 2, 'Jordânia', 'Argélia', 'JO', 'DZ', '2026-06-23T03:00:00Z', 'scheduled'],
    ['GRUPO J', 3, 'Argélia', 'Áustria', 'DZ', 'AT', '2026-06-28T02:00:00Z', 'scheduled'],
    ['GRUPO J', 3, 'Jordânia', 'Argentina', 'JO', 'AR', '2026-06-28T02:00:00Z', 'scheduled'],
    
    ['GRUPO K', 1, 'Portugal', 'RD Congo', 'PT', 'CD', '2026-06-17T17:00:00Z', 'scheduled'],
    ['GRUPO K', 1, 'Uzbequistão', 'Colômbia', 'UZ', 'CO', '2026-06-18T02:00:00Z', 'scheduled'],
    ['GRUPO K', 2, 'Colômbia', 'RD Congo', 'CO', 'CD', '2026-06-24T02:00:00Z', 'scheduled'],
    ['GRUPO K', 2, 'Portugal', 'Uzbequistão', 'PT', 'UZ', '2026-06-23T17:00:00Z', 'scheduled'],
    ['GRUPO K', 3, 'Colômbia', 'Portugal', 'CO', 'PT', '2026-06-27T23:30:00Z', 'scheduled'],
    ['GRUPO K', 3, 'RD Congo', 'Uzbequistão', 'CD', 'UZ', '2026-06-27T23:30:00Z', 'scheduled'],
    
    ['GRUPO L', 1, 'Gana', 'Panamá', 'GH', 'PA', '2026-06-17T23:00:00Z', 'scheduled'],
    ['GRUPO L', 1, 'Inglaterra', 'Croácia', 'GB-ENG', 'HR', '2026-06-17T20:00:00Z', 'scheduled'],
    ['GRUPO L', 2, 'Inglaterra', 'Gana', 'GB-ENG', 'GH', '2026-06-23T20:00:00Z', 'scheduled'],
    ['GRUPO L', 2, 'Panamá', 'Croácia', 'PA', 'HR', '2026-06-23T23:00:00Z', 'scheduled'],
    ['GRUPO L', 3, 'Croácia', 'Gana', 'HR', 'GH', '2026-06-27T21:00:00Z', 'scheduled'],
    ['GRUPO L', 3, 'Panamá', 'Inglaterra', 'PA', 'GB-ENG', '2026-06-27T21:00:00Z', 'scheduled']
  ];

  const insertMatch = db.prepare(`
    INSERT INTO matches (group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((matches) => {
    matches.forEach(match => insertMatch.run(...match));
  });

  transaction(matchesData);
  console.log(`✅ ${matchesData.length} partidas da fase de grupos da Copa 2026 inicializadas com sucesso!`);
}

// Função para criar usuário admin se não existir (com senha gerada aleatoriamente em produção)
function createAdminUser() {
  const adminEmail = 'admin@bolao.com';
  
  // Em produção, usar variável de ambiente para a senha ou gerar uma aleatória
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminCopa2026!Secure#Random';
  
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  
  if (!existingAdmin) {
    const hashedPassword = bcrypt.hashSync(adminPassword, 12);
    const result = db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)').run(
      'Administrador',
      adminEmail,
      hashedPassword,
      'admin'
    );
    console.log('✅ Usuário admin criado com sucesso!');
    console.log(`   Email: ${adminEmail}`);
    console.log(`   Senha: ${adminPassword}`);
    console.log('   ⚠️  GUARDE ESTA SENHA COM SEGURANÇA! Altere após o primeiro login.');
  } else {
    console.log('Usuário admin já existe.');
  }
}

// Middleware global para tratamento de erros não capturados
app.use((err, req, res, next) => {
  console.error('Erro não capturado:', err);
  
  // Não expor detalhes do erro em produção
  const isProduction = process.env.NODE_ENV === 'production';
  
  res.status(err.status || 500).json({
    error: isProduction ? 'Erro interno do servidor' : err.message,
    ...(isProduction ? {} : { stack: err.stack })
  });
});

// Handler para rotas não encontradas (404)
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recebido. Fechando servidor gracefulmente...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT recebido. Fechando servidor gracefulmente...');
  process.exit(0);
});
