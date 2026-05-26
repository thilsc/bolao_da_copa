# Bolão Copa 2026

Aplicação web para criação e gerenciamento de um bolão da Copa do Mundo de 2026.

## Funcionalidades

- **Fase de Grupos Completa**: Todos os jogos das 3 rodadas da fase de grupos (48 times, 12 grupos)
- **Sistema de Palpites**: 
  - Placar exato (5 pontos se acertar)
  - Resultado do jogo (2 pontos se acertar: Time A vence, Time B vence ou Empate)
- **Bandeiras dos Países**: Emojis das bandeiras ao lado dos nomes dos times
- **Restrição de Tempo**: Não é permitido alterar palpites com menos de 1 hora antes do jogo começar
- **Data e Hora GMT-3**: Todas as partidas exibem data e hora no fuso horário de Brasília
- **Ranking**: Classificação de todos os jogadores com pontuação total
- **Atualização Automática de Placares**: 
  - Manual (via interface administrativa)
  - Automática via API football-data.org
  - Job agendado a cada 6 horas

## Estrutura do Projeto

```
bolao-copa-2026/
├── backend/
│   ├── package.json
│   └── server.js
└── frontend/
    └── index.html
```

## Instalação e Execução

### Backend

```bash
cd backend
npm install
npm start
```

O servidor será iniciado na porta 3001.

### Frontend

Abra o arquivo `frontend/index.html` em seu navegador ou sirva através de um servidor web simples:

```bash
cd frontend
python -m http.server 8080
```

Acesse http://localhost:8080 no navegador.

## Configuração da API Externa

Para usar a atualização automática de placares via football-data.org:

1. Obtenha uma API key em https://www.football-data.org/
2. Configure a variável de ambiente:

```bash
export FOOTBALL_DATA_API_KEY=sua_api_key_aqui
```

## Sistema de Pontuação

- **Acertar o placar exato**: 5 pontos
- **Acertar apenas o resultado**: 2 pontos
- **Errar o resultado**: 0 pontos

## APIs Disponíveis

### Usuários
- `POST /api/users` - Registrar novo usuário
- `GET /api/users` - Listar todos os usuários

### Jogos
- `GET /api/matches` - Listar todos os jogos
- `POST /api/matches/update-scores` - Atualizar placares manualmente
- `POST /api/matches/fetch-results` - Buscar resultados da API externa

### Palpites
- `GET /api/users/:userId/predictions` - Obter palpites de um usuário
- `POST /api/predictions` - Criar/atualizar palpite
- `GET /api/matches/:matchId/predictions` - Obter palpites de todos para um jogo

### Ranking
- `GET /api/ranking` - Obter ranking geral

## Tecnologias Utilizadas

### Backend
- Node.js
- Express
- SQLite (better-sqlite3)
- Axios (para consumir API externa)
- node-cron (para jobs agendados)

### Frontend
- HTML5
- CSS3
- JavaScript (Vanilla)

## Regras do Bolão

1. Cada usuário pode fazer palpites para todos os jogos da fase de grupos
2. O palpite pode ser feito informando:
   - O placar exato (ex: 2x1)
   - OU apenas o resultado (vitória time A, empate, vitória time B)
3. Não é possível alterar palpites com menos de 1 hora antes do início da partida
4. Os pontos são calculados automaticamente quando os placares são atualizados
5. O ranking é atualizado em tempo real

## Observações

- Os dados dos jogos são inicializados automaticamente na primeira execução
- O banco de dados SQLite é criado automaticamente no diretório do backend
- A aplicação suporta múltiplos usuários simultâneos
