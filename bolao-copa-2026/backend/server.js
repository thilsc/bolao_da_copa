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

    // Grupos OFICIAIS da Copa do Mundo FIFA 2026 (sorteio de dezembro de 2025)
    const groups = [
      { name: 'A', teams: ['México', 'Coreia do Sul', 'África do Sul', 'Tchéquia'] },
      { name: 'B', teams: ['Canadá', 'Suíça', 'Qatar', 'Bósnia e Herzegovina'] },
      { name: 'C', teams: ['Brasil', 'Marrocos', 'Haiti', 'Escócia'] },
      { name: 'D', teams: ['Estados Unidos', 'Paraguai', 'Austrália', 'Turquia'] },
      { name: 'E', teams: ['Alemanha', 'Curaçao', 'Costa do Marfim', 'Equador'] },
      { name: 'F', teams: ['Holanda', 'Japão', 'Suécia', 'Tunísia'] },
      { name: 'G', teams: ['Bélgica', 'Egito', 'Irã', 'Nova Zelândia'] },
      { name: 'H', teams: ['Espanha', 'Cabo Verde', 'Arábia Saudita', 'Uruguai'] },
      { name: 'I', teams: ['França', 'Senegal', 'Iraque', 'Noruega'] },
      { name: 'J', teams: ['Argentina', 'Argélia', 'Áustria', 'Jordânia'] },
      { name: 'K', teams: ['Portugal', 'Congo DR', 'Uzbequistão', 'Colômbia'] },
      { name: 'L', teams: ['Inglaterra', 'Croácia', 'Gana', 'Panamá'] }
    ];

    const insertMatch = db.prepare(`
      INSERT INTO matches (group_name, round, team_a, team_b, team_a_flag, team_b_flag, match_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let matchId = 1;
    const baseDate = new Date('2026-06-11T13:00:00-03:00');

    groups.forEach((group, groupIndex) => {
      const groupTeams = group.teams;
      
      // Rodada 1: Time 0 vs Time 1, Time 2 vs Time 3
      // Rodada 2: Time 0 vs Time 2, Time 1 vs Time 3
      // Rodada 3: Time 0 vs Time 3, Time 1 vs Time 2
      
      const rounds = [
        [[0, 1], [2, 3]],
        [[0, 2], [1, 3]],
        [[0, 3], [1, 2]]
      ];

      rounds.forEach((round, roundIndex) => {
        round.forEach(([teamAIndex, teamBIndex], matchIndex) => {
          const teamA = groupTeams[teamAIndex];
          const teamB = groupTeams[teamBIndex];
          
          // Calcular data e hora (GMT-3)
          const matchDate = new Date(baseDate.getTime() + 
            (groupIndex * 3 + roundIndex) * 24 * 60 * 60 * 1000 + 
            matchIndex * 3 * 60 * 60 * 1000);
          
          const dateStr = matchDate.toISOString().replace('Z', '-03:00');
          
          insertMatch.run(
            `Grupo ${group.name}`,
            roundIndex + 1,
            teamA,
            teamB,
            teams[teamA] || '🏳️',
            teams[teamB] || '🏳️',
            dateStr
          );
          matchId++;
        });
      });
    });

    console.log(`${matchId - 1} jogos inicializados com sucesso!`);
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
