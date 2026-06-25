# BonkTools-Core

TypeScript monorepo que substitui o acesso ao **bonk.io** via Puppeteer/browser por uma conexão direta via Socket.IO client. Expõe uma biblioteca (`@bonktools/core`) e aplicativos prontos para gerenciar salas 24h com múltiplos hosts simultâneos.

**Por que isso existe?** Automatizar o bonk.io com Puppeteer exige um browser completo (~300 MB RAM, headless instável, tela virtual no Linux). BonkTools conecta diretamente ao protocolo Socket.IO do jogo — **< 15 MB RAM por sala**, sem Chromium, sem Xvfb, sem automação de UI frágil.

---

## Índice

- [Estrutura do monorepo](#estrutura-do-monorepo)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Biblioteca @bonktools/core](#biblioteca-bonktoolscore)
  - [Autenticação e descoberta de servidor](#autenticação-e-descoberta-de-servidor)
  - [Criar uma sala](#criar-uma-sala)
  - [Entrar em uma sala](#entrar-em-uma-sala)
  - [Eventos da sala](#eventos-da-sala)
  - [BonkSession — múltiplas salas com resiliência 24h](#bonksession--múltiplas-salas-com-resiliência-24h)
- [Apps incluídos](#apps-incluídos)
  - [bonk-room](#bonk-room)
  - [room-manager](#room-manager)
- [Exemplos](#exemplos)
- [Configuração](#configuração)
- [Deploy com PM2](#deploy-com-pm2)
- [Decisões técnicas](#decisões-técnicas)

---

## Estrutura do monorepo

```
BonkTools-Core/
├── packages/
│   └── core/                   # @bonktools/core — biblioteca principal
│       ├── src/
│       │   ├── auth/           # Login HTTP + descoberta de servidor
│       │   ├── codec/          # Encode/decode dos packets Socket.IO
│       │   ├── transport/      # Camada WebSocket (Socket.IO v2, EIO=3)
│       │   ├── room/           # BonkRoom + estado da sala + reconexão
│       │   ├── session/        # BonkSession — pool de salas 24h
│       │   ├── football/       # IS blobs padrão para football
│       │   └── cli/            # CLI: capture-is
│       └── certs/
│           └── bonk_fullchain.pem   # CA Sectigo bundlada
├── apps/
│   ├── bonk-room/              # Bot de sala única de football com pick de times
│   └── room-manager/           # App terminal multi-sala com REPL
├── examples/
│   └── basic-room/             # Exemplo mínimo de uso da lib
└── scripts/
    └── soak.ts                 # Soak test 24h: N salas, amostra RSS em CSV
```

---

## Requisitos

| Dependência | Versão mínima |
|---|---|
| Node.js | `>=20.18.1` (recomendado: Node 22 LTS) |
| pnpm | `>=9` |

---

## Instalação

```bash
# Clonar e instalar dependências
git clone https://github.com/brenoluizdev/BonkTools-Core-repo.git
cd BonkTools-Core
pnpm install

# Compilar a biblioteca core
pnpm --filter @bonktools/core build
```

---

## Biblioteca @bonktools/core

A biblioteca exporta tudo necessário para interagir com o bonk.io de forma programática.

### Autenticação e descoberta de servidor

Antes de criar ou entrar em uma sala, é preciso obter um token de sessão e descobrir qual servidor WebSocket usar.

```ts
import { AuthClient } from '@bonktools/core';

const client = new AuthClient();

// Login com conta registrada do bonk.io
const token = await client.getToken('seu_usuario', 'sua_senha');

// Descobre qual servidor WebSocket usar (ex: "b2seattle1")
const serverInfo = await client.discoverServer(token);
```

### Criar uma sala

```ts
import { createRoom } from '@bonktools/core';

const room = await createRoom({
  server: serverInfo,
  auth: { type: 'registered', username: 'seu_usuario', password: 'sua_senha' },
  name: 'Minha Sala',
  maxPlayers: 6,
  password: '',     // string vazia = sem senha
  hidden: false,
  mode: 'b',        // 'b' = classic
  rounds: 3,
});

console.log('Sala criada:', room.shareLink);
// https://bonk.io/123456
```

Para entrar como convidado:

```ts
const room = await createRoom({
  server: serverInfo,
  auth: { type: 'guest', guestName: 'MeuBot' },
  name: 'Sala do Bot',
  maxPlayers: 6,
});
```

### Entrar em uma sala

```ts
import { joinRoom } from '@bonktools/core';

// Pela URL pública da sala
const room = await joinRoom({
  auth: { type: 'registered', username: 'seu_usuario', password: 'sua_senha' },
  roomUrl: 'https://bonk.io/123456',
});
```

### Eventos da sala

`BonkRoom` é um `EventEmitter3` fortemente tipado. Todos os eventos refletem os packets do protocolo bonk.io.

```ts
// Jogador entrou
room.on('player-join', (packet) => {
  console.log(`${packet.userName} entrou no time ${packet.team}`);
});

// Jogador saiu
room.on('player-leave', (packet) => {
  console.log(`Jogador ${packet.id} saiu`);
});

// Mensagem no chat
room.on('chat-message', (packet) => {
  if (packet.message === '!ping') {
    room.sendChat('pong!');
  }
});

// Jogo iniciou
room.on('game-start', (packet) => {
  console.log('Jogo iniciado, IS blob:', packet.is?.length ?? 0, 'chars');
});

// Jogo terminou
room.on('game-end', () => {
  console.log('Rodada encerrada');
});

// Sala morreu (sem reconexão possível)
room.on('dead', ({ reason }) => {
  console.error('Sala morreu:', reason);
});
```

**Ações do host:**

```ts
// Mover jogador de time
room.setPlayerTeam(playerId, 2);  // 2 = BLUE, 3 = RED, 0 = SPEC

// Iniciar jogo (apenas host)
room.startGame({
  is: initialStateBlob,   // LZ-string do estado inicial de física
  gs: { bal: [] },        // bal: [] = atribuição automática de corpos
});

// Iniciar contagem regressiva
room.startCountdown(3);   // "3, 2, 1..."

// Chutar jogador
room.kickPlayer(playerId);

// Enviar mensagem no chat
room.sendChat('Bem-vindo!');

// Fechar o jogo (voltar ao lobby)
room.returnToLobby();
```

**Estado atual da sala:**

```ts
const state = room.state;

console.log(state.myId);        // ID do bot na sala (0 se host)
console.log(state.hostId);      // ID do host atual
console.log(state.roomId);      // ID numérico da sala
console.log(state.shareLink);   // URL pública (ex: https://bonk.io/123456)
console.log(state.players);     // Map<id, PlayerData>
console.log(state.teamsLocked); // boolean
```

### BonkSession — múltiplas salas com resiliência 24h

`BonkSession` gerencia um pool de salas e mantém todas ativas por tempo indeterminado. Ele autentica uma vez e compartilha o token entre todas as salas, reconecta automaticamente em caso de queda, e possui um reconcile loop de 60s para detectar salas que caíram silenciosamente.

```ts
import { BonkSession } from '@bonktools/core';

const session = new BonkSession({
  auth: { type: 'registered', username: 'seu_usuario', password: 'sua_senha' },
  throttle: {
    capacity: 3,              // máximo de salas simultâneas
    refillPerSec: 1 / 3,      // uma nova sala a cada 3s
  },
});

session.on('room-added', (localId) => {
  const entry = session.rooms.get(localId);
  if (!entry) return;

  console.log('Sala criada:', entry.room.shareLink);

  // Configurar listeners na sala
  entry.room.on('chat-message', (p) => {
    if (p.message === '!link') entry.room.sendChat(entry.room.shareLink ?? '');
  });
});

session.on('room-dead-terminal', ({ localId, reason }) => {
  console.error(`Sala ${localId} morreu permanentemente:`, reason);
});

// Autenticar e iniciar salas
await session.getToken(session.auth);
await session.startFromConfig({
  rooms: [
    { id: 'sala-1', name: 'Sala 1', maxPlayers: 6, password: '', mode: 'b', rounds: 3, hidden: false },
    { id: 'sala-2', name: 'Sala 2', maxPlayers: 6, password: '', mode: 'b', rounds: 3, hidden: false },
  ],
});

// Encerrar tudo graciosamente
process.on('SIGTERM', async () => {
  await session.destroy();
  process.exit(0);
});
```

---

## Apps incluídos

### bonk-room

Bot de sala única de football com sistema automático de pick de times. Usa `BonkSession` com um único `BonkRoom` e o `PickController` para gerenciar as partidas.

**Funcionalidades:**
- Detecta número de jogadores e configura times automaticamente
  - 1 jogador ativo → modo solo
  - 2 jogadores → 1v1
  - 4 jogadores → 2v2
- Auto-start: inicia a partida automaticamente quando os times estiverem completos
- Rotação de challengers após cada partida
- Detecção de interrupção (novo jogador entra durante partida)
- IS blobs pré-capturados para cada configuração de time
- Resiliência 24h via `BonkSession`

**Configuração:**

Copie `.env.example` para `.env` e preencha:

```env
BONK_USERNAME=seu_usuario
BONK_PASSWORD=sua_senha
```

Configure a sala em `bonk-room.json`:

```json
{
  "room": {
    "id": "minha-sala",
    "name": "Minha Sala Football",
    "password": "",
    "maxPlayers": 6,
    "mode": "b",
    "rounds": 3,
    "hidden": true,
    "map": "<LZ-string do mapa football>"
  },
  "throttle": {
    "maxConcurrentRooms": 1,
    "roomCreationDelayMs": 3000,
    "roomCreationJitterMs": 2000
  },
  "initialStates": {
    "2": "<IS blob para 1v1>",
    "4": "<IS blob para 2v2>"
  }
}
```

**Executar:**

```bash
# Desenvolvimento (logs formatados)
pnpm --filter bonk-room dev

# Produção (logs JSON)
NODE_ENV=production pnpm --filter bonk-room start

# Capturar IS blob de uma sala ao vivo
pnpm --filter bonk-room capture-is https://bonk.io/123456
```

### room-manager

App terminal para gerenciar múltiplas salas simultaneamente via REPL interativo. Útil para administração manual de salas.

```bash
pnpm --filter room-manager dev
```

---

## Exemplos

O diretório `examples/basic-room/` contém um bot mínimo comentado demonstrando o uso básico da biblioteca:

```bash
cd examples/basic-room
cp .env.example .env
# Editar .env com suas credenciais
pnpm install
pnpm dev
```

O bot do exemplo implementa:
- Criar sala e aguardar jogadores
- Responder `!ping` com `pong!`
- Iniciar jogo com `!start`
- Shutdown gracioso com SIGTERM/SIGINT

---

## Configuração

### Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `BONK_USERNAME` | Sim | Usuário da conta bonk.io |
| `BONK_PASSWORD` | Sim | Senha da conta bonk.io |
| `NODE_ENV` | Não | `development` (logs pretty) ou `production` (logs JSON) |
| `BONK_INITIAL_STATE` | Não | IS blob LZ-string (sobrescreve o do config file) |
| `BONK_GAMEMODE` | Não | `football` (padrão) ou outro modo suportado |
| `BONK_MAXTEAMSIZE` | Não | Tamanho máximo do time (padrão: 1) |
| `BONK_ROUNDS` | Não | Número de rounds (padrão: 3) |

### Capturar o IS blob (football)

O IS blob é um estado inicial de física capturado de uma sessão ao vivo. Sem ele, a engine de física dos clientes não inicializa e os jogadores não aparecem em campo.

```bash
# Abra uma sala de football manualmente no navegador,
# depois execute com a URL dela:
pnpm --filter @bonktools/core capture-is https://bonk.io/123456

# Ou via bonk-room:
pnpm --filter bonk-room capture-is https://bonk.io/123456
```

O blob capturado deve ser colocado no `bonk-room.json` em `initialStates["<n>"]` onde `n` é o número de jogadores ativos (sem contar o bot em spec).

Os blobs padrão para 1, 2 e 4 jogadores no mapa football padrão já estão embutidos na biblioteca em `@bonktools/core` e são usados automaticamente se nenhum blob customizado for configurado.

---

## Deploy com PM2

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Compilar para produção
pnpm --filter @bonktools/core build
pnpm --filter bonk-room build

# Iniciar com PM2
pm2 start apps/bonk-room/dist/index.js --name bonk-room --env production

# Salvar para reiniciar automaticamente no boot
pm2 save
pm2 startup
```

---

## Decisões técnicas

**Por que `socket.io-client@2` e não a versão mais recente?**
O servidor bonk.io fala o protocolo Engine.IO 3 (`EIO=3`). O cliente v4 negocia `EIO=4` e não tem opção de downgrade — a conexão falha imediatamente no handshake. A versão 2.5.0 é a última da linha v2 e a única compatível.

**Por que `undici` e não `fetch` nativo?**
O bonk.io serve uma cadeia TLS Sectigo incompleta. O `fetch` nativo do Node.js não permite injetar uma CA customizada por requisição sem monkeypatch global. O `undici.Agent` permite configurar a CA Sectigo por cliente, sem afetar outras requisições HTTPS do processo.

**Por que o CA Sectigo está bundlado?**
Usar o TLS store padrão do Node.js rejeitaria a cadeia incompleta do bonk.io. Ao invés de desativar toda a verificação TLS globalmente (o que o BonkBot original faz com `NODE_TLS_REJECT_UNAUTHORIZED=0`), o projeto bundla a cadeia completa Sectigo e injeta apenas onde necessário.

**Por que `EventEmitter3` e não o `EventEmitter` nativo?**
EventEmitter3 tem tipagem genérica por evento (`EventEmitter<Events>`), o que permite `room.on('player-join', handler)` com o tipo do `handler` inferido corretamente pelo TypeScript.
