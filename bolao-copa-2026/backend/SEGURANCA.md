# Documento de Segurança - Bolão Copa 2026

## Medidas de Segurança Implementadas

### 1. Proteção Contra Ataques Comuns

#### Helmet.js - Cabeçalhos HTTP Seguros
- Content Security Policy (CSP) configurada
- Proteção contra clickjacking (X-Frame-Options)
- HSTS (HTTP Strict Transport Security)
- XSS Filter habilitado
- NoSniff para prevenir MIME sniffing

#### Rate Limiting
- **Geral**: 100 requisições por IP a cada 15 minutos
- **Login**: 5 tentativas por IP a cada 15 minutos (prevenir força bruta)
- **Registro**: 3 registros por IP por hora
- **Admin**: 20 requisições por IP a cada 15 minutos

#### Validação e Sanitização de Inputs
- Sanitização de todos os inputs do usuário
- Validação de email com regex
- Validação de senha forte (mínimo 8 caracteres, maiúscula, minúscula, número e caractere especial)
- Validação de tipos e intervalos numéricos
- Prevenção contra SQL Injection usando prepared statements
- Prevenção contra XSS com xss-clean
- Prevenção contra HPP (HTTP Parameter Pollution)

### 2. Autenticação e Autorização

#### JWT (JSON Web Tokens)
- JWT_SECRET com mínimo de 32 caracteres obrigatório
- Token expira em 24 horas
- Payload contém apenas dados necessários (id, email, role)

#### Controle de Acesso
- Middleware `authenticateToken` para rotas protegidas
- Middleware `isAdmin` para funcionalidades administrativas
- Usuários só podem acessar seus próprios dados
- Lista de usuários protegida (apenas admin)

#### Senhas
- Hash com bcrypt (12 rounds)
- Mensagens de erro genéricas no login (prevenir enumeração de usuários)
- Senha do admin configurável via variável de ambiente

### 3. Proteção de Dados

#### Banco de Dados
- Prepared statements para todas as queries SQL
- Transações para operações críticas (atomicidade)
- Senhas nunca são retornadas nas respostas da API

#### Informações Sensíveis
- Email não exposto no ranking
- IDs de usuários validados como inteiros
- Logs não contêm dados sensíveis

### 4. Configuração do Servidor

#### Binding
- Servidor bindado apenas em localhost (127.0.0.1)
- Para produção, configurar proxy reverso (nginx, Apache)

#### CORS
- Origem restrita à APP_URL configurada
- Métodos limitados (GET, POST, PUT, DELETE)
- Headers permitidos específicos

#### Timeout
- Timeout de 10 segundos em requisições externas
- Tratamento de erros de conexão

### 5. Variáveis de Ambiente Obrigatórias

O servidor valida na inicialização:
- `FOOTBALL_DATA_API_KEY` - Chave da API football-data.org
- `JWT_SECRET` - Mínimo 32 caracteres
- `APP_URL` - URL da aplicação

### 6. Tratamento de Erros

- Middleware global de erro
- Em produção, detalhes do erro não são expostos
- Logs de erro para debugging
- Handler 404 para rotas não encontradas

### 7. Graceful Shutdown

- Handlers para SIGTERM e SIGINT
- Fechamento ordenado do servidor

## Credenciais do Administrador

**Email:** `admin@bolao.com`

**Senha:** Definida em `ADMIN_PASSWORD` no .env ou use a padrão (altere imediatamente!)

## Recomendações para Produção

1. **Altere TODAS as senhas padrão**
2. **Gere um JWT_SECRET forte:**
   ```bash
   openssl rand -base64 32
   ```
3. **Configure HTTPS** com certificado SSL válido
4. **Use um proxy reverso** (nginx/Apache) para:
   - Terminação SSL
   - Rate limiting adicional
   - Cache de conteúdo estático
5. **Monitore logs** regularmente
6. **Mantenha dependências atualizadas**
7. **Faça backup regular** do banco de dados
8. **Considere usar** um serviço de WAF (Web Application Firewall)

## Endpoints Protegidos

### Apenas Administrador
- `POST /api/matches/update-scores` - Atualizar placares manualmente
- `POST /api/matches/fetch-results` - Buscar resultados da API externa
- `GET /api/users` - Listar todos os usuários

### Requer Autenticação
- `GET /api/users/:userId/predictions` - Ver palpites (usuário vê apenas os seus)
- `POST /api/predictions` - Fazer palpite (apenas para si mesmo)
- `GET /api/matches/:matchId/predictions` - Ver palpites de um jogo

### Públicos
- `POST /api/users` - Registrar novo usuário (com rate limiting)
- `POST /api/login` - Login (com rate limiting rigoroso)
- `GET /api/matches` - Listar jogos
- `GET /api/ranking` - Ranking de usuários
- `GET /health` - Health check

## Auditoria de Segurança Realizada

✅ Validação de variáveis de ambiente obrigatórias
✅ Validação de força do JWT_SECRET
✅ Rate limiting implementado
✅ Helmet.js configurado
✅ Validação e sanitização de inputs
✅ Prepared statements para SQL
✅ Hash de senhas com bcrypt (12 rounds)
✅ Controle de acesso baseado em roles
✅ CORS configurado corretamente
✅ Tratamento de erros seguro
✅ Timeout em requisições externas
✅ Transações para operações críticas
✅ Graceful shutdown
✅ Health check endpoint
