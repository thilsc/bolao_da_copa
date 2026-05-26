const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

// Configurar banco de dados SQLite
const db = new Database('./bolao.db');

// Criar tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
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

// Inicializar jogos da fase de grupos
function initializeMatches() {
  const count = db.prepare('SELECT COUNT(*) as count FROM matches').get().count;
  
  if (count === 0) {
    // Dados dos times com emojis de bandeiras — Copa do Mundo FIFA 2026 (sorteio oficial)
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

    // Jogos OFICIAIS da Copa do Mundo FIFA 2026 — confrontos e horários em GMT-3 (Brasília)
    // Sorteio realizado em dezembro de 2025 | Fonte: FIFA.com
    // Formato: [grupo, rodada, timeA, timeB, data ISO em GMT-3]
    const fixtures = [
      // ── GRUPO A ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo A', 1, 'México',        'África do Sul',       '2026-06-11T16:00:00-03:00'],
      ['Grupo A', 1, 'Coreia do Sul', 'Tchéquia',            '2026-06-11T23:00:00-03:00'],
      // Rodada 2
      ['Grupo A', 2, 'Tchéquia',      'África do Sul',       '2026-06-18T13:00:00-03:00'],
      ['Grupo A', 2, 'México',        'Coreia do Sul',       '2026-06-18T22:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo A', 3, 'México',        'Tchéquia',            '2026-06-24T22:00:00-03:00'],
      ['Grupo A', 3, 'Coreia do Sul', 'África do Sul',       '2026-06-24T22:00:00-03:00'],

      // ── GRUPO B ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo B', 1, 'Canadá',              'Bósnia e Herzegovina', '2026-06-12T16:00:00-03:00'],
      ['Grupo B', 1, 'Qatar',               'Suíça',               '2026-06-13T19:00:00-03:00'],
      // Rodada 2
      ['Grupo B', 2, 'Canadá',              'Qatar',               '2026-06-19T19:00:00-03:00'],
      ['Grupo B', 2, 'Bósnia e Herzegovina','Suíça',               '2026-06-20T16:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo B', 3, 'Suíça',              'Canadá',              '2026-06-25T20:30:00-03:00'],
      ['Grupo B', 3, 'Bósnia e Herzegovina','Qatar',               '2026-06-25T20:30:00-03:00'],

      // ── GRUPO C ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo C', 1, 'Brasil',   'Marrocos', '2026-06-13T19:00:00-03:00'],
      ['Grupo C', 1, 'Haiti',    'Escócia',  '2026-06-16T13:00:00-03:00'],
      // Rodada 2
      ['Grupo C', 2, 'Brasil',   'Haiti',    '2026-06-19T22:00:00-03:00'],
      ['Grupo C', 2, 'Marrocos', 'Escócia',  '2026-06-19T16:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo C', 3, 'Brasil',   'Escócia',  '2026-06-24T19:00:00-03:00'],
      ['Grupo C', 3, 'Marrocos', 'Haiti',    '2026-06-24T19:00:00-03:00'],

      // ── GRUPO D ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo D', 1, 'Estados Unidos', 'Paraguai',  '2026-06-12T22:00:00-03:00'],
      ['Grupo D', 1, 'Austrália',      'Turquia',   '2026-06-13T22:00:00-03:00'],
      // Rodada 2
      ['Grupo D', 2, 'Estados Unidos', 'Austrália', '2026-06-20T13:00:00-03:00'],
      ['Grupo D', 2, 'Paraguai',       'Turquia',   '2026-06-20T19:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo D', 3, 'Estados Unidos', 'Turquia',   '2026-06-25T22:00:00-03:00'],
      ['Grupo D', 3, 'Paraguai',       'Austrália', '2026-06-25T22:00:00-03:00'],

      // ── GRUPO E ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo E', 1, 'Alemanha',       'Curaçao',         '2026-06-14T14:00:00-03:00'],
      ['Grupo E', 1, 'Costa do Marfim','Equador',         '2026-06-14T20:00:00-03:00'],
      // Rodada 2
      ['Grupo E', 2, 'Alemanha',       'Costa do Marfim', '2026-06-20T22:00:00-03:00'],
      ['Grupo E', 2, 'Curaçao',        'Equador',         '2026-06-21T13:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo E', 3, 'Alemanha',       'Equador',         '2026-06-26T16:00:00-03:00'],
      ['Grupo E', 3, 'Curaçao',        'Costa do Marfim', '2026-06-26T16:00:00-03:00'],

      // ── GRUPO F ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo F', 1, 'Holanda', 'Japão',   '2026-06-14T17:00:00-03:00'],
      ['Grupo F', 1, 'Suécia',  'Tunísia', '2026-06-14T23:00:00-03:00'],
      // Rodada 2
      ['Grupo F', 2, 'Holanda', 'Suécia',  '2026-06-21T19:00:00-03:00'],
      ['Grupo F', 2, 'Tunísia', 'Japão',   '2026-06-21T01:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo F', 3, 'Holanda', 'Tunísia', '2026-06-26T20:30:00-03:00'],
      ['Grupo F', 3, 'Japão',   'Suécia',  '2026-06-26T20:30:00-03:00'],

      // ── GRUPO G ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo G', 1, 'Bélgica',       'Egito',        '2026-06-15T16:00:00-03:00'],
      ['Grupo G', 1, 'Irã',           'Nova Zelândia', '2026-06-15T22:00:00-03:00'],
      // Rodada 2
      ['Grupo G', 2, 'Bélgica',       'Irã',          '2026-06-21T16:00:00-03:00'],
      ['Grupo G', 2, 'Egito',         'Nova Zelândia', '2026-06-22T13:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo G', 3, 'Bélgica',       'Nova Zelândia', '2026-06-26T22:00:00-03:00'],
      ['Grupo G', 3, 'Egito',         'Irã',           '2026-06-26T22:00:00-03:00'],

      // ── GRUPO H ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo H', 1, 'Espanha',       'Cabo Verde',    '2026-06-15T13:00:00-03:00'],
      ['Grupo H', 1, 'Arábia Saudita','Uruguai',       '2026-06-15T19:00:00-03:00'],
      // Rodada 2
      ['Grupo H', 2, 'Espanha',       'Arábia Saudita','2026-06-21T13:00:00-03:00'],
      ['Grupo H', 2, 'Cabo Verde',    'Uruguai',       '2026-06-22T19:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo H', 3, 'Espanha',       'Uruguai',       '2026-06-27T13:00:00-03:00'],
      ['Grupo H', 3, 'Cabo Verde',    'Arábia Saudita','2026-06-27T13:00:00-03:00'],

      // ── GRUPO I ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo I', 1, 'França',   'Senegal', '2026-06-16T19:00:00-03:00'],
      ['Grupo I', 1, 'Iraque',   'Noruega', '2026-06-16T22:00:00-03:00'],
      // Rodada 2
      ['Grupo I', 2, 'França',   'Iraque',  '2026-06-22T16:00:00-03:00'],
      ['Grupo I', 2, 'Senegal',  'Noruega', '2026-06-22T22:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo I', 3, 'França',   'Noruega', '2026-06-27T16:00:00-03:00'],
      ['Grupo I', 3, 'Senegal',  'Iraque',  '2026-06-27T16:00:00-03:00'],

      // ── GRUPO J ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo J', 1, 'Argentina', 'Jordânia', '2026-06-17T22:00:00-03:00'],
      ['Grupo J', 1, 'Argélia',   'Áustria',  '2026-06-17T13:00:00-03:00'],
      // Rodada 2
      ['Grupo J', 2, 'Argentina', 'Áustria',  '2026-06-23T22:00:00-03:00'],
      ['Grupo J', 2, 'Argélia',   'Jordânia', '2026-06-22T22:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo J', 3, 'Argentina', 'Argélia',  '2026-06-27T20:30:00-03:00'],
      ['Grupo J', 3, 'Áustria',   'Jordânia', '2026-06-27T20:30:00-03:00'],

      // ── GRUPO K ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo K', 1, 'Portugal',   'Congo DR',     '2026-06-17T16:00:00-03:00'],
      ['Grupo K', 1, 'Colômbia',   'Uzbequistão',  '2026-06-17T19:00:00-03:00'],
      // Rodada 2
      ['Grupo K', 2, 'Portugal',   'Uzbequistão',  '2026-06-23T16:00:00-03:00'],
      ['Grupo K', 2, 'Colômbia',   'Congo DR',     '2026-06-23T13:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo K', 3, 'Portugal',   'Colômbia',     '2026-06-27T22:00:00-03:00'],
      ['Grupo K', 3, 'Congo DR',   'Uzbequistão',  '2026-06-27T22:00:00-03:00'],

      // ── GRUPO L ──────────────────────────────────────────────────────────────
      // Rodada 1
      ['Grupo L', 1, 'Inglaterra', 'Croácia', '2026-06-17T16:00:00-03:00'],
      ['Grupo L', 1, 'Gana',       'Panamá',  '2026-06-16T16:00:00-03:00'],
      // Rodada 2
      ['Grupo L', 2, 'Inglaterra', 'Gana',    '2026-06-23T19:00:00-03:00'],
      ['Grupo L', 2, 'Croácia',    'Panamá',  '2026-06-23T22:00:00-03:00'],
      // Rodada 3 (simultâneos)
      ['Grupo L', 3, 'Inglaterra', 'Panamá',  '2026-06-27T20:30:00-03:00'],
      ['Grupo L', 3, 'Croácia',    'Gana',    '2026-06-27T20:30:00-03:00'],
    ];

    const insertMatch = db.prepare(`
      INSERT INTO matches (group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    fixtures.forEach(([group, round, teamA, teamB, date]) => {
      insertMatch.run(group, round, teamA, teamB, teams[teamA] || '🏳️', teams[teamB] || '🏳️', date);
    });

    console.log(`${fixtures.length} jogos inicializados com sucesso!`);
  }
}

// API Routes

// Registrar usuário
app.post('/api/users', (req, res) => {
  try {
    const { name, email } = req.body;
    const result = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(name, email);
    res.json({ id: result.lastInsertRowid, name, email });
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      res.status(400).json({ error: 'Email já cadastrado' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Listar usuários
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all();
  res.json(users);
});

// Listar todos os jogos
app.get('/api/matches', (req, res) => {
  const matches = db.prepare('SELECT * FROM matches ORDER BY group_name, round, match_date').all();
  res.json(matches);
});

// Obter palpites de um usuário
app.get('/api/users/:userId/predictions', (req, res) => {
  const { userId } = req.params;
  const predictions = db.prepare(`
    SELECT p.*, m.team_a, m.team_b, m.team_a_flag, m.team_b_flag, m.match_date, m.score_a, m.score_b, m.status
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE p.user_id = ?
    ORDER BY m.match_date
  `).all(userId);
  res.json(predictions);
});

// Fazer ou atualizar palpite
app.post('/api/predictions', (req, res) => {
  try {
    const { userId, matchId, predictedScoreA, predictedScoreB, predictedResult } = req.body;
    
    // Verificar se o jogo já começou ou está prestes a começar (menos de 1 hora)
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) {
      return res.status(404).json({ error: 'Jogo não encontrado' });
    }

    const matchDate = new Date(match.match_date);
    const now = new Date();
    const oneHourBefore = new Date(matchDate.getTime() - 60 * 60 * 1000);

    if (now >= oneHourBefore) {
      return res.status(400).json({ 
        error: 'Não é permitido alterar palpites com menos de 1 hora antes do jogo começar' 
      });
    }

    // Verificar se já existe palpite
    const existing = db.prepare('SELECT * FROM predictions WHERE user_id = ? AND match_id = ?').get(userId, matchId);

    if (existing) {
      db.prepare(`
        UPDATE predictions 
        SET predicted_score_a = ?, predicted_score_b = ?, predicted_result = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND match_id = ?
      `).run(predictedScoreA, predictedScoreB, predictedResult, userId, matchId);
    } else {
      db.prepare(`
        INSERT INTO predictions (user_id, match_id, predicted_score_a, predicted_score_b, predicted_result)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, matchId, predictedScoreA, predictedScoreB, predictedResult);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar placares manualmente
app.post('/api/matches/update-scores', async (req, res) => {
  try {
    const { matches } = req.body;
    
    const updateMatch = db.prepare(`
      UPDATE matches 
      SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    matches.forEach(({ id, scoreA, scoreB }) => {
      updateMatch.run(scoreA, scoreB, id);
    });

    // Calcular pontos para todos os usuários
    calculatePoints();

    res.json({ success: true, message: `${matches.length} placares atualizados` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Consumir API externa (football-data.org)
app.post('/api/matches/fetch-results', async (req, res) => {
  try {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    
    if (!apiKey) {
      return res.status(500).json({ error: 'API key não configurada' });
    }

    // Exemplo de consumo da API football-data.org
    const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
      headers: { 'X-Auth-Token': apiKey }
    });

    const matches = response.data.matches;
    const updateMatch = db.prepare(`
      UPDATE matches 
      SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
      WHERE team_a = ? AND team_b = ?
    `);

    let updatedCount = 0;
    matches.forEach(match => {
      if (match.status === 'FINISHED' && match.score.fullTime.home !== null) {
        updateMatch.run(
          match.score.fullTime.home,
          match.score.fullTime.away,
          match.homeTeam.name,
          match.awayTeam.name
        );
        updatedCount++;
      }
    });

    // Calcular pontos
    calculatePoints();

    res.json({ success: true, message: `${updatedCount} resultados atualizados da API` });
  } catch (error) {
    console.error('Erro ao buscar dados da API:', error.message);
    res.status(500).json({ error: 'Erro ao consumir API externa' });
  }
});

// Função para calcular pontos
function calculatePoints() {
  const predictions = db.prepare(`
    SELECT p.*, m.score_a, m.score_b
    FROM predictions p
    JOIN matches m ON p.match_id = m.id
    WHERE m.status = 'finished' AND m.score_a IS NOT NULL
  `).all();

  const updatePrediction = db.prepare(`
    UPDATE predictions SET points = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);

  predictions.forEach(pred => {
    let points = 0;

    // Determinar resultado real
    let actualResult;
    if (pred.score_a > pred.score_b) {
      actualResult = 'A';
    } else if (pred.score_b > pred.score_a) {
      actualResult = 'B';
    } else {
      actualResult = 'draw';
    }

    // Verificar acerto do placar exato
    if (pred.predicted_score_a === pred.score_a && pred.predicted_score_b === pred.score_b) {
      points = 5;
    } 
    // Verificar acerto apenas do resultado
    else if (pred.predicted_result === actualResult) {
      points = 2;
    }

    updatePrediction.run(points, pred.id);
  });

  console.log('Pontos calculados com sucesso!');
}

// Ranking de usuários
app.get('/api/ranking', (req, res) => {
  const ranking = db.prepare(`
    SELECT u.id, u.name, u.email, COALESCE(SUM(p.points), 0) as total_points, COUNT(p.id) as predictions_count
    FROM users u
    LEFT JOIN predictions p ON u.id = p.user_id
    GROUP BY u.id, u.name, u.email
    ORDER BY total_points DESC, predictions_count ASC, u.name ASC
  `).all();
  
  res.json(ranking);
});

// Obter palpites de todos os usuários para um jogo específico
app.get('/api/matches/:matchId/predictions', (req, res) => {
  const { matchId } = req.params;
  const predictions = db.prepare(`
    SELECT u.name, p.predicted_score_a, p.predicted_score_b, p.predicted_result, p.points
    FROM predictions p
    JOIN users u ON p.user_id = u.id
    WHERE p.match_id = ?
    ORDER BY p.points DESC
  `).all(matchId);
  res.json(predictions);
});

// Job agendado para atualizar placares automaticamente (a cada 6 horas)
cron.schedule('0 */6 * * *', async () => {
  console.log('Executando atualização automática de placares...');
  try {
    const apiKey = process.env.FOOTBALL_DATA_API_KEY;
    if (apiKey) {
      const response = await axios.get('https://api.football-data.org/v4/competitions/WC/matches', {
        headers: { 'X-Auth-Token': apiKey }
      });

      const matches = response.data.matches;
      const updateMatch = db.prepare(`
        UPDATE matches 
        SET score_a = ?, score_b = ?, status = 'finished', updated_at = CURRENT_TIMESTAMP
        WHERE team_a = ? AND team_b = ?
      `);

      matches.forEach(match => {
        if (match.status === 'FINISHED' && match.score.fullTime.home !== null) {
          updateMatch.run(
            match.score.fullTime.home,
            match.score.fullTime.away,
            match.homeTeam.name,
            match.awayTeam.name
          );
        }
      });

      calculatePoints();
      console.log('Atualização automática concluída!');
    }
  } catch (error) {
    console.error('Erro na atualização automática:', error.message);
  }
});

// Inicializar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  initializeMatches();
});
