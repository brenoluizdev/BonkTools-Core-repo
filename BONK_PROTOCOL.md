# Protocolo bonk.io — Documentação Técnica

Documentação do protocolo de rede do [bonk.io](https://bonk.io), obtida por análise do tráfego WebSocket e engenharia reversa do cliente. O objetivo é explicar como o jogo se comunica para possibilitar clientes headless, bots e ferramentas de automação.

---

## Índice

- [Stack de rede](#stack-de-rede)
- [Autenticação HTTP](#autenticação-http)
- [Conexão WebSocket](#conexão-websocket)
- [Framing dos pacotes](#framing-dos-pacotes)
- [IDs de pacotes — Incoming](#ids-de-pacotes--incoming-servidor--cliente)
- [IDs de pacotes — Outgoing](#ids-de-pacotes--outgoing-cliente--servidor)
- [Fluxo de uma sessão completa](#fluxo-de-uma-sessão-completa)
- [Estado da sala](#estado-da-sala)
- [Times](#times)
- [GameSettings e TRIGGER_START](#gamesettings-e-trigger_start)
- [IS blob — Initial State](#is-blob--initial-state)
- [INFORM_IN_LOBBY](#inform_in_lobby)
- [Heartbeat e anti-idle](#heartbeat-e-anti-idle)
- [StatusCodes](#statuscodes)
- [Armadilhas e pitfalls](#armadilhas-e-pitfalls)

---

## Stack de rede

O bonk.io usa **Socket.IO v2** sobre WebSocket.

| Camada | Tecnologia |
|---|---|
| Transporte | WebSocket (TLS) |
| Engine.IO | versão 3 (`EIO=3`) |
| Socket.IO | versão 2 |
| Framing | `42[eventId, payload]` |
| Serialização | JSON |

**Por que isso importa:** O cliente Socket.IO v4 (atual) negocia `EIO=4`, que o servidor bonk.io rejeita no handshake. Não há flag de downgrade no cliente v4. Para conectar ao bonk.io, é obrigatório usar `socket.io-client@2.x`.

### TLS — cadeia Sectigo incompleta

O servidor bonk.io (`*.bonk.io`) serve uma cadeia TLS com a intermediária Sectigo ausente. Clientes com TLS estrito rejeitam a conexão.

**Solução correta:** Injetar a cadeia Sectigo completa como CA customizada nas requisições HTTP e WebSocket. Isso evita desativar a verificação TLS globalmente.

**Solução incorreta (não faça):** `NODE_TLS_REJECT_UNAUTHORIZED=0` — desativa a verificação TLS para todo o processo Node.js.

---

## Autenticação HTTP

Todas as requisições HTTP vão para `https://bonk2.io/scripts/`. São `POST` com body `application/x-www-form-urlencoded`.

### 1. Login — obter token

```
POST https://bonk2.io/scripts/login_legacy.php
Content-Type: application/x-www-form-urlencoded

username=<usuario>&password=<senha>&remember=false
```

**Resposta:**
```json
{ "token": "abc123..." }
```

O `token` é usado nas chamadas seguintes.

### 2. Descoberta de servidor — getrooms

```
POST https://bonk2.io/scripts/getrooms.php
Content-Type: application/x-www-form-urlencoded

version=49&gl=y&token=<token>
```

**Resposta:**
```json
{
  "createserver": "b2seattle1",
  "lat": 47.6,
  "long": -122.3,
  "country": "US"
}
```

O campo `createserver` indica qual instância do servidor WebSocket usar para criar salas. A URL do WebSocket será `https://b2seattle1.bonk.io`.

### 3. Entrar em sala via URL — autojoin

```
POST https://bonk2.io/scripts/autojoin.php
Content-Type: application/x-www-form-urlencoded

joinID=<roomId>
```

**Resposta:**
```json
{
  "r": "success",
  "server": "b2seattle1",
  "address": "b2seattle1.bonk.io",
  "roomname": "Nome da Sala",
  "passbypass": "abcde"
}
```

O `server` indica em qual instância a sala está hospedada. O `passbypass` é usado como `bypass` no packet de JOIN_ROOM para entrar sem senha.

### Versão do protocolo

O campo `version` nas requisições HTTP é **49**. Versões diferentes podem ser rejeitadas pelo servidor.

---

## Conexão WebSocket

Após descobrir o servidor, conectar via Socket.IO v2:

```
URL: https://<server>.bonk.io
```

**Opções obrigatórias do socket:**

| Opção | Valor | Motivo |
|---|---|---|
| `transports` | `['websocket']` | Sem polling — direto para WebSocket |
| `reconnection` | `false` | Reconexão gerenciada manualmente |
| `forceNode` | `true` | Força uso do `ws@7` em vez do WebSocket global do Node 22 |
| `rejectUnauthorized` | `false` | Cadeia Sectigo incompleta (escopado ao socket) |

### PeerID

O cliente gera um `peerID` local de 16 caracteres: 10 chars base36 aleatórios + sufixo fixo `"a00000"`.

```
Exemplo: "vuzvugdrnja00000"
```

O PeerID é enviado no packet CREATE_ROOM ou JOIN_ROOM e identifica o cliente durante a sessão.

---

## Framing dos pacotes

O Socket.IO v2 transmite dados no formato:

```
42[<eventId>, <payload>]
```

- `4` = tipo de pacote Socket.IO (MESSAGE)
- `2` = subtipo (EVENT)
- `<eventId>` = número inteiro que identifica o tipo de evento bonk.io
- `<payload>` = objeto JSON com os dados do evento

Quando recebido pelo listener `socket.on(<eventId>, handler)`, o argumento passado ao handler é apenas o `payload` (o `eventId` já foi extraído pelo Socket.IO).

**ATENÇÃO:** Os namespaces de IDs são distintos por direção. O número `20` no sentido servidor→cliente é `CHAT_MESSAGE`. O mesmo número `20` no sentido cliente→servidor é `SEND_MODE`. São eventos completamente diferentes.

---

## IDs de pacotes — Incoming (servidor → cliente)

| ID | Nome | Descrição |
|---|---|---|
| 1 | PLAYER_PINGS | Pings de todos os jogadores. Deve ser respondido com PING_RESPONSE (outgoing 1). |
| 2 | ROOM_CREATED | Confirmação de que a sala foi criada. Contém `sockId` (socket ID) e `myId` (sempre 0). |
| 3 | JOIN_ROOM | Estado completo da sala ao entrar. Array `players` com índices (null = slot vazio). |
| 4 | PLAYER_JOIN | Um novo jogador entrou. O host deve responder com INFORM_IN_LOBBY (outgoing 11). |
| 5 | PLAYER_LEAVE | Um jogador saiu. |
| 6 | HOST_LEAVE | O host saiu. Contém `oldHostId` e `newHostId` (-1 = sala fechada). |
| 8 | READY_CHANGE | Um jogador marcou/desmarcou ready. |
| 9 | ALL_READY_RESET | Todos os readys foram resetados. |
| 12 | USERNAME_CHANGE | Um jogador mudou de nome. |
| 13 | GAME_END | O jogo terminou (rodada encerrada). |
| 15 | GAME_START | O jogo iniciou. Contém `is` (IS blob) e `gs` (GameSettings). |
| 16 | STATUS_MESSAGE | Mensagem de status do servidor (erros, rate limits, etc.). |
| 18 | TEAM_CHANGE | Um jogador mudou de time. |
| 19 | TEAMLOCK_TOGGLE | Times foram travados ou destravados. |
| 20 | CHAT_MESSAGE | Mensagem de chat. Contém `id` (jogador) e `message`. |
| 23 | TIMESYNC | Resposta do heartbeat de sincronização de tempo. |
| 24 | PLAYER_KICK | Um jogador foi expulso. |
| 26 | GAMEMODE_CHANGE | Modo de jogo alterado. Contém `engine` e `mode`. |
| 27 | CHANGE_ROUNDS | Número de rounds alterado. |
| 29 | MAP_SWITCH | Mapa da sala alterado. Contém o objeto `data` do mapa. |
| 33 | MAP_SUGGEST | Host sugeriu um mapa (dados completos). |
| 34 | MAP_SUGGEST_CLIENT | Host sugeriu um mapa (metadados: título, autor, playerId). |
| 36 | BALANCE_SET | Balance de um jogador alterado. |
| 43 | COUNTDOWN | Contagem regressiva iniciada. Contém `n` (número exibido). |
| 44 | ABORT_COUNTDOWN | Contagem regressiva cancelada. |
| 45 | PLAYER_LEVEL_UP | Um jogador subiu de nível. |
| 49 | SHARE_LINK | URL pública da sala. Contém `roomId` (numérico) e `bypass` (5 chars). |
| 52 | TABBED | Um jogador minimizou/restaurou a janela do jogo. |
| 58 | ROOM_NAME_UPDATE | Nome da sala alterado. |
| 59 | ROOM_PASSWORD_UPDATE | Senha da sala alterada. Contém `hasPassword` (0 ou 1). |

---

## IDs de pacotes — Outgoing (cliente → servidor)

| ID | Nome | Descrição |
|---|---|---|
| 1 | PING_RESPONSE | Resposta obrigatória ao PLAYER_PINGS. Contém `{id: pingId}`. |
| 5 | TRIGGER_START | Iniciar o jogo. Contém IS blob e GameSettings. |
| 6 | CHANGE_OWN_TEAM | Mudar o próprio time. Contém `{targetTeam}`. |
| 7 | TEAM_LOCK | Travar/destravar times. Contém `{teamLock: boolean}`. |
| 9 | KICK_BAN_PLAYER | Expulsar jogador. Contém `{banshortid, kickonly?: true}`. |
| 10 | CHAT_MESSAGE | Enviar mensagem no chat. Contém `{message}`. |
| 11 | INFORM_IN_LOBBY | Sincronizar estado da sala com jogador recém-entrado. Ver seção dedicada. |
| 12 | CREATE_ROOM | Criar nova sala. Contém peerID, nome, maxPlayers, senha, configurações. |
| 13 | JOIN_ROOM | Entrar em sala existente. Contém joinID, avatar, versão, peerID, bypass. |
| 14 | RETURN_TO_LOBBY | Encerrar partida e voltar ao lobby (sem payload). |
| 16 | SET_READY | Marcar pronto/não pronto. Contém `{ready: boolean}`. |
| 17 | ALL_READY_RESET | Resetar todos os readys (sem payload). |
| 18 | TIMESYNC | Heartbeat de sincronização de tempo. Formato JSON-RPC 2.0. |
| 20 | SEND_MODE | Alterar modo de jogo. Contém `{ga, mo}`. |
| 21 | SEND_ROUNDS | Alterar número de rounds. Contém `{w: rounds}`. |
| 22 | SEND_MAP_DELETE | Remover mapa customizado. Contém `{d: 0}`. |
| 23 | SEND_MAP_ADD | Adicionar mapa. Contém `{m: <LZ-string do mapa>}`. |
| 26 | CHANGE_OTHER_TEAM | Mover outro jogador de time. Contém `{targetID, targetTeam}`. |
| 32 | SEND_TEAM_SETTINGS | Configurar modo de times. Contém `{t: boolean}`. |
| 34 | SEND_HOST_CHANGE | Transferir host para outro jogador. Contém `{id}`. |
| 36 | SEND_START_COUNTDOWN | Iniciar contagem regressiva. Contém `{num}` (número inicial). |
| 37 | SEND_ABORT_COUNTDOWN | Cancelar contagem regressiva (sem payload). |
| 50 | SEND_NO_HOST_SWAP | Desativar troca automática de host (sem payload). |
| 52 | SET_ROOM_NAME | Alterar nome da sala. Contém `{newName}`. |
| 53 | SET_ROOM_PASSWORD | Alterar senha da sala. Contém `{newPass}`. |

---

## Fluxo de uma sessão completa

### Criar sala

```
Cliente                          Servidor
   |                                |
   |-- CREATE_ROOM (out 12) ------->|
   |<-- ROOM_CREATED (in 2) --------|  (myId = 0, sockId)
   |<-- SHARE_LINK (in 49) ---------|  (roomId, bypass)
   |<-- PLAYER_JOIN (in 4) ---------|  (o próprio bot, id=0)
   |                                |
   |  [outro jogador entra]         |
   |<-- PLAYER_JOIN (in 4) ---------|  (id=1, userName, team, ...)
   |-- INFORM_IN_LOBBY (out 11) --->|  (sincroniza estado com o novo jogador)
   |                                |
   [heartbeat a cada 5s]
   |-- TIMESYNC (out 18) ---------->|
   |<-- TIMESYNC (in 23) -----------|
```

### Iniciar jogo

```
   |-- TRIGGER_START (out 5) ------>|  (is blob + GameSettings)
   |<-- GAME_START (in 15) ---------|  (servidor ecoa o is blob de volta)
   |                                |
   [jogo em andamento...]
   |                                |
   |<-- GAME_END (in 13) -----------|
```

### Entrar em sala existente

```
Cliente                          Servidor
   |                                |
   |-- JOIN_ROOM (out 13) --------->|  (joinID, peerID, bypass, ...)
   |<-- JOIN_ROOM (in 3) -----------|  (estado completo: players[], hostId, myId, ...)
   |<-- PLAYER_JOIN (in 4) ---------|  (o próprio bot, confirmação)
   |<-- PLAYER_PINGS (in 1) --------|
   |-- PING_RESPONSE (out 1) ------>|
```

---

## Estado da sala

Ao receber o packet **JOIN_ROOM (incoming 3)**, o cliente recebe o estado inicial completo:

```ts
{
  myId: number,           // ID do cliente nesta sala
  hostId: number,         // ID do host atual
  players: Array<Player | null>,  // array com índices — null = slot vazio
  timestamp: number,      // timestamp do servidor
  teamsLocked: boolean,
  roomId: number,
  roomBypass: string,     // bypass de senha (5 chars)
}
```

**Importante:** Quem CRIA a sala nunca recebe o packet JOIN_ROOM (in 3). O criador recebe apenas ROOM_CREATED (in 2) e deve registrar `myId = 0` e `hostId = 0` manualmente — o criador é sempre o jogador 0 e sempre o host inicial.

### PlayerData

```ts
{
  id: number,           // índice no array de players (= ID na sala)
  peerID: string,       // peer ID do cliente (16 chars)
  userName: string,
  guest: boolean,
  level: number,
  team: number,         // ver seção de Times
  avatar: object,       // aparência do personagem
}
```

---

## Times

| Valor | Constante | Descrição |
|---|---|---|
| 0 | SPEC | Espectador — não participa do jogo |
| 1 | FFA | Free-for-all — modo sem times definidos |
| 2 | BLUE | Time azul |
| 3 | RED | Time vermelho |
| 4 | GREEN | Time verde |
| 5 | YELLOW | Time amarelo |

---

## GameSettings e TRIGGER_START

Para iniciar um jogo, o host envia **TRIGGER_START (outgoing 5)** com:

```ts
{
  is: string,        // IS blob — LZ-string do estado inicial de física
  gs: {
    map: string,     // LZ-string do mapa atual
    gt: number,      // game type — padrão: 2
    wl: number,      // win limit (número de rounds)
    q: boolean,      // quick play
    tl: boolean,     // teams locked
    tea: boolean,    // teams enabled
    ga: string,      // engine: 'b' (bonk clássico) ou 'f' (football)
    mo: string,      // mode: 'b' (classic)
    bal: Record<number, number> | unknown[],  // bro body assignment
  }
}
```

O servidor recebe esse payload, valida, e ecoa de volta para todos os clientes via **GAME_START (incoming 15)**.

### Campo `bal` — bro body assignment

O `bal` define qual "bro body" (personagem físico) cada jogador controla.

- `bal: []` — array vazio: o servidor atribui corpos em ordem crescente de ID. Simples, mas pode resultar em posições de spawn incorretas se jogadores entraram/saíram e há gaps nos IDs.
- `bal: {0: 0, 1: 1, 2: 2}` — mapeamento explícito `playerId → bodyIndex`. Garante que cada jogador receba o spawn correto independente de gaps de ID.

Para football com times fixos (ex: 1v1 ou 2v2), **sempre use mapeamento explícito** para garantir que azuis spawnam no lado azul e vermelhos no lado vermelho.

---

## IS blob — Initial State

O IS blob (Initial State) é uma **LZ-string** que codifica o estado inicial dos bro bodies: posições de spawn, rotações, velocidades e quais bodies existem na partida.

**Por que é necessário:** Sem o IS blob, o servidor inicia a partida com `is=""` e os clientes recebem um blob vazio — a engine de física não inicializa e os jogadores não aparecem em campo. O jogo parece travar no carregamento.

**O blob varia conforme o número de jogadores ativos.** Um blob capturado para 1v1 (2 jogadores ativos) não funciona para 2v2 (4 jogadores ativos) porque o número de bro bodies codificados é diferente.

**O servidor ecoa o blob sem modificar.** O que o host envia em TRIGGER_START é exatamente o que os clientes recebem em GAME_START.

### Capturar o IS blob

A forma mais confiável é capturar de uma sessão ao vivo:

1. Abrir o bonk.io no navegador, criar uma sala de football com o número de jogadores correto, e iniciar o jogo
2. Capturar o packet GAME_START (incoming 15) via WebSocket inspector ou ferramenta dedicada
3. Extrair o campo `is` desse packet

### Blobs padrão para football

Para o mapa football padrão do bonk.io, os blobs variam por número de jogadores **ativos** (excluindo bots em espectador):

| Chave | Configuração | Bro bodies |
|---|---|---|
| `"1"` | Solo (1 jogador ativo) | 2 bodies |
| `"2"` | 1v1 (2 jogadores ativos) | 3 bodies |
| `"4"` | 2v2 (4 jogadores ativos) | 5 bodies |

Não existe blob padrão para 3 jogadores (1v1 + 1 em spec é coberto pelo blob de 2 jogadores; 3v0 não é uma configuração válida de football).

---

## INFORM_IN_LOBBY

**O packet mais crítico para implementar corretamente.**

Quando um novo jogador entra na sala (PLAYER_JOIN, incoming 4), o **host deve imediatamente enviar INFORM_IN_LOBBY (outgoing 11)** de volta. Esse packet sincroniza o estado atual da sala com o cliente recém-chegado.

**Se o INFORM_IN_LOBBY não for enviado:** O cliente exibe "Initial data timeout." e não consegue sincronizar o estado da sala. O jogador fica preso na tela de carregamento.

### Payload do INFORM_IN_LOBBY

```ts
{
  sid: number,    // ID do jogador que entrou (do packet PLAYER_JOIN)
  gs: {
    map: object,  // objeto JSON do mapa — NÃO é LZ-string aqui, é o objeto descomprimido
    gt: number,   // game type
    wl: number,   // win limit
    q: boolean,   // quick play
    tl: boolean,  // teams locked
    tea: boolean, // teams enabled
    ga: string,   // engine
    mo: string,   // mode
    bal: object,  // bro body assignment
  }
}
```

**Atenção no campo `map`:** No TRIGGER_START, o mapa vai como LZ-string no campo `gs.map`. No INFORM_IN_LOBBY, o mapa vai como **objeto JSON descomprimido**. São formatos diferentes para o mesmo dado.

### Mapa padrão (sem mapa customizado)

Quando nenhum mapa customizado está ativo na sala, o INFORM_IN_LOBBY deve enviar o mapa vazio padrão:

```ts
{
  dbid: 767645,
  // physics com shapes, fixtures, bodies, joints, bro todos vazios
  // nome: "Empty Map", autor: "BonkTools"
}
```

---

## Heartbeat e anti-idle

### Heartbeat TIMESYNC

O cliente deve enviar **TIMESYNC (outgoing 18)** a cada **5 segundos**. Sem isso, o servidor considera o cliente inativo.

```ts
// Formato JSON-RPC 2.0
{
  jsonrpc: '2.0',
  id: <numero_incrementado>,
  method: 'timesync'
}
```

O servidor responde com **TIMESYNC (incoming 23)**:

```ts
{
  result: number,   // timestamp do servidor
  id: number        // mesmo id enviado
}
```

### Anti-idle

Para salas que ficam no lobby por longos períodos sem atividade de jogadores, o servidor pode desconectar o host por inatividade após ~30 minutos. Para evitar isso, o bot executa a sequência:

1. Muda para time 2 (BLUE) via CHANGE_OWN_TEAM (outgoing 6)
2. Aguarda um momento
3. Volta para time 0 (SPEC) via CHANGE_OWN_TEAM

Essa sequência deve ser repetida a cada ~29 minutos.

---

## StatusCodes

O packet **STATUS_MESSAGE (incoming 16)** carrega um campo `status` com uma string que descreve o resultado de uma operação. Muitos desses códigos indicam rate limiting.

### Rate limits

| Status | Operação |
|---|---|
| `arm rate limited` | Ação genérica limitada |
| `rate_limit_ready` | SET_READY muito frequente |
| `join_rate_limited` | JOIN_ROOM muito frequente |
| `host_change_rate_limited` | Troca de host muito frequente |
| `rate_limit_mapsuggest` | MAP_SUGGEST muito frequente |
| `rate_limit_countdown` | SEND_START_COUNTDOWN muito frequente |
| `rate_limit_abortcountdown` | SEND_ABORT_COUNTDOWN muito frequente |
| `rate_limit_sma` | SEND_MAP_ADD muito frequente |
| `rate_limit_cot` | CHANGE_OTHER_TEAM muito frequente |
| `rate_limit_sgt` | SEND_TEAM_SETTINGS muito frequente |
| `rate_limit_rtl` | RETURN_TO_LOBBY muito frequente |
| `rate_limit_pong` | PING_RESPONSE muito frequente |
| `rate_limit_tl` | TEAM_LOCK muito frequente |
| `rate_limit` | Rate limit genérico |

### Terminais

| Status | Significado |
|---|---|
| `banned` | Cliente banido da sala |
| `room_full` | Sala cheia (ver Pitfalls) |
| `room_not_found` | Sala não encontrada |
| `password_wrong` | Senha incorreta |
| `old_rotation` | Versão do protocolo desatualizada |
| `Initial data timeout.` | INFORM_IN_LOBBY não recebido a tempo |

### Informativos

| Status | Significado |
|---|---|
| `no_client_entry` | Cliente não encontrado na sala |
| `already_in_this_room` | Tentativa de entrar na própria sala |
| `guest` | Operação disponível apenas para contas registradas |
| `not_hosting` | Tentativa de ação de host sem ser host |
| `cant_ban_yourself` | Tentativa de banir a si mesmo |
| `Connect error` | Erro de conexão |

---

## Armadilhas e pitfalls

### Pitfall 1 — players[] é array com índices (não lista densa)

O campo `players` no packet JOIN_ROOM (incoming 3) é um **array esparso**. O índice é o ID do jogador. Slots vagos são `null`.

```
players = [
  { id: 0, userName: "bot", ... },   // ID 0
  null,                               // slot 1 vazio
  { id: 2, userName: "jogador", ... } // ID 2
]
```

Iterar com `for...of` ou `.forEach` inclui os `null`. Use `players.filter(Boolean)` ou itere com `for (let i = 0; i < players.length; i++)` verificando `if (players[i] !== null)`.

### Pitfall 2 — criador da sala não recebe JOIN_ROOM

Quem cria a sala recebe apenas ROOM_CREATED (in 2), não JOIN_ROOM (in 3). O protocolo não envia o estado inicial para o criador — ele É o estado inicial. Registre `myId = 0` e `hostId = 0` manualmente ao receber ROOM_CREATED.

### Pitfall 3 — `room_full` é ambíguo

O servidor envia `status: 'room_full'` em dois contextos diferentes:

1. **Ao tentar entrar em sala cheia:** `myId` ainda é `null`. É terminal — o bot não conseguiu entrar.
2. **Quando outro jogador tenta entrar na sala cheia:** `myId` já existe. É apenas informativo — o bot está na sala, só outro jogador foi recusado.

Distingua sempre verificando se o bot já está na sala (`myId !== null`) antes de tratar `room_full` como erro fatal.

### Pitfall 4 — INFORM_IN_LOBBY deve ser enviado para cada PLAYER_JOIN

Cada vez que um jogador entra (PLAYER_JOIN, in 4), o host precisa responder com INFORM_IN_LOBBY contendo o `sid` desse jogador específico. O packet não é broadcast — é dirigido ao jogador que acabou de entrar.

### Pitfall 5 — map em INFORM_IN_LOBBY não é LZ-string

Ao iniciar o jogo (TRIGGER_START), o mapa vai como LZ-string comprimida. No INFORM_IN_LOBBY, o mesmo mapa vai como **objeto JSON descomprimido**. Enviar LZ-string onde deveria ser objeto causa erro de sincronização no cliente.

### Pitfall 6 — IS blob depende do número de jogadores ativos

Um IS blob de 1v1 tem 2 bro bodies codificados. Se usado em uma partida 2v2 (que precisa de 4 bro bodies), 2 jogadores não terão posição de spawn e não aparecem em campo. Sempre capture ou configure o blob correto para cada configuração de times.

### Pitfall 7 — nenhum packet é emitido antes de `connect`

O evento `connect` do socket.io-client é assíncrono. Listeners para packets de jogo (ROOM_CREATED, JOIN_ROOM, etc.) devem ser registrados antes de chamar `socket.connect()`, ou dentro do callback do `connect`. Packets emitidos pelo servidor antes do listener estar pronto são perdidos.

### Pitfall 8 — IDs de outgoing e incoming são namespaces distintos

O ID `20` no sentido cliente→servidor é `SEND_MODE`. O ID `20` no sentido servidor→cliente é `CHAT_MESSAGE`. Nunca confundir os dois namespaces. Documentar sempre com a direção explícita.

### Pitfall 9 — bal: [] pode causar spawns incorretos em football com IDs não-contíguos

Se jogadores saíram e entraram durante a sessão, os IDs de jogadores podem ter gaps (ex: IDs 0, 2, 4 — o ID 1 e 3 saíram). Com `bal: []`, o servidor atribui bro bodies em ordem crescente de ID, o que pode resultar em um jogador BLUE spawning no lado RED. Use mapeamento explícito `{playerId: bodyIndex}` para garantir a atribuição correta.

---

## URL das salas

```
https://bonk.io/<roomId><bypass>
```

- `roomId`: 6 dígitos numéricos
- `bypass`: 5 caracteres alfanuméricos opcionais (permite entrar sem senha)

Exemplo: `https://bonk.io/123456abcde`

O `roomId` e `bypass` são recebidos no packet **SHARE_LINK (incoming 49)** após criar a sala.
