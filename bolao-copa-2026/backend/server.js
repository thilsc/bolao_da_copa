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
app.use(cors({
  origin: process.env.APP_URL || 'http://localhost:3001',
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

// Register
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
  if (password.length < 6)
    return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

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
app.post('/api/users', registerLimiter, (req, res) => {
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
    res.status(201).json({ id: result.lastInsertRowid, name: sanitizedName, email: sanitizedEmail });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Email já cadastrado' });
    } else {
      console.error('Erro ao registrar usuário:', error);
      res.status(500).json({ error: 'Erro interno do servidor' });
    }

    await sendVerificationEmail(email, name, token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// Listar usuários (protegido - apenas admin)
app.get('/api/users', authenticateToken, isAdmin, (req, res) => {
  // Não retornar senhas
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY name').all();
  res.json(users);
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

// Consumir API externa (football-data.org) - apenas admin - com timeout e validações
app.post('/api/matches/fetch-results', authenticateToken, isAdmin, adminLimiter, async (req, res) => {
  try {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key não configurada' });

    // Configurar timeout para a requisição
    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': apiKey },
      timeout: 10000, // 10 segundos de timeout
      maxRedirects: 3,
      validateStatus: (status) => status === 200
    });

    if (!response.data || !response.data.matches) {
      return res.status(500).json({ error: 'Resposta inválida da API' });
    }

    const matches = response.data.matches;
    const updateMatch = db.prepare(`
      UPDATE matches 
      SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
      WHERE team_a = ? AND team_b = ?
    `);

    let updatedCount = 0;
    
    // Usar transação para garantir atomicidade
    const transaction = db.transaction(() => {
      matches.forEach(match => {
        if (match.status === 'FINISHED' && match.score.fullTime.home !== null) {
          const homeScore = parseInt(match.score.fullTime.home, 10);
          const awayScore = parseInt(match.score.fullTime.away, 10);
          
          if (!isNaN(homeScore) && !isNaN(awayScore) && homeScore >= 0 && awayScore >= 0) {
            updateMatch.run(
              homeScore,
              awayScore,
              sanitizeInput(match.homeTeam.name),
              sanitizeInput(match.awayTeam.name)
            );
            updatedCount++;
          }
        }
      });
    });
    
    transaction();

    // Calcular pontos
    calculatePoints();

    res.json({ success: true, message: `${updatedCount} resultados atualizados da API` });
  } catch (error) {
    console.error('Erro ao buscar dados da API:', error.message);
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Timeout ao conectar com API externa' });
    }
    res.status(500).json({ error: 'Erro ao consumir API externa' });
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
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) return;
  try {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (apiKey) {
      const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
        headers: { 'X-Auth-Token': apiKey },
        timeout: 10000, // 10 segundos de timeout
        maxRedirects: 3
      });

      if (!response.data || !response.data.matches) {
        console.error('Resposta inválida da API no job agendado');
        return;
      }

      const matches = response.data.matches;
      const updateMatch = db.prepare(`
        UPDATE matches 
        SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
        WHERE team_a = ? AND team_b = ?
      `);

      let updatedCount = 0;
      
      // Usar transação para garantir atomicidade
      const transaction = db.transaction(() => {
        matches.forEach(match => {
          if (match.status === 'FINISHED' && match.score.fullTime.home !== null) {
            const homeScore = parseInt(match.score.fullTime.home, 10);
            const awayScore = parseInt(match.score.fullTime.away, 10);
            
            if (!isNaN(homeScore) && !isNaN(awayScore) && homeScore >= 0 && awayScore >= 0) {
              updateMatch.run(
                homeScore,
                awayScore,
                sanitizeInput(match.homeTeam.name),
                sanitizeInput(match.awayTeam.name)
              );
              updatedCount++;
            }
          }
        });
      });
      
      transaction();

      calculatePoints();
      console.log(`Atualização automática concluída! ${updatedCount} jogos atualizados.`);
    }
  } catch (error) {
    console.error('Erro na atualização automática:', error.message);
  }
});

// Endpoint de health check (sem rate limiting)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Inicializar servidor - apenas em localhost por segurança
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Servidor rodando em http://127.0.0.1:${PORT}`);
  console.log('⚠️  Servidor configurado para aceitar conexões apenas do localhost');
  initializeMatches();
  createAdminUser();
});

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
