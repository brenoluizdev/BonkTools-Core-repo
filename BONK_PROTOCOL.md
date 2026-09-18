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
- [Sincronização de partida — WebRTC/PeerJS](#sincronização-de-partida--webrtcpeerjs)
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

## INFORM_IN_GAME (packet 40) — sincronizar jogador com partida já ativa

**Não fazia parte do escopo original do bonktools.** Descoberto consultando documentação
externa de terceiros ([UnmatchedBracket/DemystifyBonk](https://github.com/UnmatchedBracket/DemystifyBonk),
`Packets.md`, seção `out40`) depois de confirmar (ver seção "Sincronização de partida" acima)
que nem WebRTC (Fase A/B/C) nem INFORM_IN_LOBBY resolvem o bug do jogador tardio sozinhos.

**O que documenta:** existe um packet dedicado, separado de INFORM_IN_LOBBY, que o host envia
a um jogador específico (via `sid`, mesmo padrão do INFORM_IN_LOBBY — **não é broadcast**)
quando ele entra numa sala com partida **já em andamento**. Carrega um `allData.state`
(blob de física, mesmo papel do `is` do TRIGGER_START) + configurações — permite sincronizar
esse jogador sem precisar de um TRIGGER_START novo (que reiniciaria o jogo pra todo mundo).

### Payload (exemplo capturado, fonte: DemystifyBonk)

```ts
{
  sid: number,           // ID do jogador a sincronizar
  allData: {
    state: string,       // blob de física (LZ-string) — mesmo papel do `is` de TRIGGER_START
    stateID: number,      // não confirmado — exemplo real sempre mostrou 1
    fc: number,           // frame count — tick da partida (~30Hz, mesma cadência do campo
                           // `f` observado no DataChannel — ver seção WebRTC/PeerJS acima)
    inputs: unknown[],     // não confirmado — vazio no exemplo capturado
    admin: unknown[],      // não confirmado — vazio no exemplo capturado
    gs: { map, gt, wl, q, tl, tea, ga, mo, bal },  // mesmo shape do TRIGGER_START (gs.map como LZ-string)
    random: unknown[],     // não confirmado — provável seed de RNG determinístico
  }
}
```

### Status da implementação no bonktools (EXPERIMENTAL)

Implementado em `BonkRoom.informInGame(sid, fc, opts)` (`packages/core/src/room/BonkRoom.ts`),
chamado por `PickController` quando um jogador entra em spec com o jogo já ativo
(`apps/bonk-room/src/pick/PickController.ts`).

**Limitação conhecida:** o bonktools não roda física de verdade — `allData.state` aqui reusa
o MESMO `is` blob já em uso pelo TRIGGER_START ativo (posições de spawn iniciais), não um
snapshot LIVE das posições atuais da partida. `fc` é estimado por tempo decorrido desde o
`startGame()`, não o tick real do servidor.

### Teste real (2026-09-17) — não resolveu, e diagnóstico direto no client descarta a hipótese do WebRTC

Reproduzido com 3 abas de navegador reais (Chrome via automação) no cenário exato: PlayerX +
PlayerX2 formam 1v1, PlayerX3 entra depois com o jogo já ativo. `informInGame` confirmado
enviado (log: `sid:4, fc:1782, stateLen:555`, sem erro do servidor). **Resultado: jogador
ainda preso no lobby.**

Diagnóstico direto no client de PlayerX3 (via `document.querySelector('#maingameframe')`,
inspecionando o DOM real do iframe do jogo):

- O elemento `#newbonklobby` (painel de lobby com roster/times) permanece **visível o tempo
  todo** — nunca é substituído pela visão da partida.
- O elemento `#gamerenderer` (onde o canvas do jogo real é criado) existe no DOM mas fica
  **sempre vazio** (`innerHTML: ""`, nenhum `<canvas>` filho) — o motor de física/render nunca
  chega a inicializar pra esse jogador. Comparado com um jogador ATIVO (ex: PlayerX), que tem
  um `<canvas>` real dentro de `#gamerenderer` com dimensões válidas (ex: 1001x686px).
- **Sem nenhum erro no console** — a falha é silenciosa, não uma exceção capturável.
- A janela "Auto Joining... / P2P ready / Synchronized / ... / Joined room, awaiting first
  data" (`#sm_connectingWindow`, texto encontrado em `alpha2s.js`) **não está relacionada a
  isso** — é o handshake de entrada na SALA (Socket.IO + WebRTC pra todos os peers,
  independente de partida ativa), que PlayerX3 já completa normalmente. A seção anterior
  deste documento presumia que esse texto era sobre "assistir a partida" especificamente;
  na prática ele é sobre entrar na sala, ponto — reclassificar essa suposição.
- O botão "Spectate" da UI apenas manda `CHANGE_OWN_TEAM` (packet 6, `{targetTeam:0}`) —
  **não existe nenhum packet outgoing dedicado que o client envie pra "pedir" pra assistir**
  a uma partida ativa. O client fica passivo esperando o HOST empurrar dados suficientes.
- Confirmado inspecionando `alpha2s.js` (bundle principal do client, minificado): os nomes
  de campo `allData`/`stateID` existem no bundle, e o código que o CLIENT usa internamente
  pra CONSTRUIR um INFORM_IN_GAME (quando ele próprio é host) monta exatamente
  `{sid, allData}` como um único objeto — **o mesmo formato que o bonktools já envia**. Ou
  seja, o formato do pacote em si não é o problema.

**Conclusão:** o gatilho que falta não é o pacote 40 em si (formato confirmado correto) nem
o handshake WebRTC (Fase A/B/C, completo e sem erros) — é o CONTEÚDO de `allData.state`
(reusar o blob estático de spawn, e não um snapshot real da posição atual dos corpos) que
provavelmente faz o handler de recepção do client rejeitar/ignorar silenciosamente os dados,
sem nunca criar o canvas. Confirmar isso exigiria localizar e decodificar o handler de
RECEBIMENTO do packet 40 dentro de `alpha2s.js` (só a construção do lado de envio foi
localizada nesta sessão) — não foi possível dentro do tempo/contexto disponível.

### RESOLVIDO (2026-09-18) — o client só aceita UM pacote de dados iniciais

**Causa raiz confirmada** (inspeção dinâmica do client via CDP, sem alterar o bundle): o
INFORM_IN_GAME chega ao spectator como **incoming 48** e o handler dele (`recvInGame`) começa
com `if (v$q[91]) return;` — flag de "dados iniciais já recebidos", já setada pelo
INFORM_IN_LOBBY (incoming 21) que o host mandava SEMPRE antes. O 48 era entregue e ignorado na
primeira linha, sem tocar em `state`/`gs` (por isso sem erro nem canvas). As hipóteses anteriores
(conteúdo de `allData.state`, ordem de envio, WebRTC) estavam erradas — o blob de spawn reusado
funciona.

**Regra:** com partida ativa o host deve mandar INFORM_IN_GAME **em vez de** INFORM_IN_LOBBY,
nunca os dois. Implementado em `BonkRoom` (guarda `activeGame` = opts do startGame + instante do
GAME_START; no PLAYER_JOIN escolhe o pacote). `fc` é estimado por tempo (~30Hz); o handler aborta
com erro 701 se `agora − início − fc·33ms > 30s`, então `fc` estimado por baixo é seguro.
Validado ao vivo (puppeteer, 3 clients, futebol 1v1 + spectator tardio): canvas renderizado,
lobby oculto, sem reiniciar a partida.

Como inspecionar (útil p/ próximos bugs de client): hook em `Object.prototype._callbacks` captura
os emitters do socket.io; o `[[Scopes]]` do handler (via CDP `Runtime.getProperties`) dá acesso a
`w0O`/`k7V`/`M$QCc` e aos listeners internos (`W7P(nome, dados)` é o despachante de eventos; o
nome do 48 é `recvInGame`).
Reescrever o alpha2s.js NÃO funciona (anti-adulteração).

**Alternativa pragmática confirmada funcionando** (testada e depois revertida por ser
disruptiva — ver commits anteriores): forçar `stopGame()`/restart quando o espectador entra,
reusando o MESMO `is`/`bal` já validado. Funciona porque reusa o fluxo de `GAME_START` que
o client já sabe processar (não depende de decifrar o formato de `allData`), ao custo de
interromper a partida ativa a cada jogador novo.

---

## Sincronização de partida — WebRTC/PeerJS

**Descoberta tardia (não fazia parte do escopo original do bonktools) — a física da partida em andamento não trafega pelo Socket.IO documentado acima.** Ela é sincronizada via **WebRTC peer-to-peer, sinalizado através de um broker PeerJS padrão** (sem customização — mesma `key`, mesmo formato de `id`/`token` do client PeerJS oficial). O Socket.IO cobre só a camada de lobby/roster (join, team, chat, GAME_START/GAME_END como sinalização); a física em si nunca passa por ele.

Isso foi descoberto investigando um bug relatado: jogadores que entram numa sala **durante** uma partida já ativa ficam presos na tela de lobby, sem nunca ver o jogo em andamento (issue original: bot headless não completava handshake WebRTC e a conexão expirava — ver Pitfall 10).

### Descoberta do broker

Capturada interceptando `WebSocket` dentro do `#maingameframe` do client real:

```
wss://<server>.bonk.io/myapp/peerjs?key=peerjs&id=<peerID>&token=<token>
```

- `<server>` — mesmo hostname da conexão Socket.IO principal (`BonkTransport`)
- `key=peerjs` — chave padrão do servidor PeerJS (sem customização)
- `id=<peerID>` — o MESMO peerID já gerado localmente e enviado em CREATE_ROOM/JOIN_ROOM (ver [PeerID](#peerid)) — é assim que outros clients sabem pra qual id endereçar um `OFFER`
- `token=<token>` — token de sessão gerado pelo client, ~11 chars base36 (`Math.random().toString(36).slice(2)`, mesmo default do client PeerJS oficial)

### Topologia — malha completa

**Todo client abre uma conexão WebRTC com TODO OUTRO peer da sala — incluindo o host**, mesmo que o host nunca jogue (seja só um bot administrativo em spec). Confirmado comparando:

- Host real (navegador) recebendo `OFFER` de um jogador → responde `ANSWER` + troca `CANDIDATE` normalmente, sem `EXPIRE`.
- Host headless (bonktools, antes do fix) recebendo o mesmo `OFFER` → nunca responde (sem WebRTC implementado) → o peer que ofertou recebe `EXPIRE` depois de um tempo.

Isso significa que **o host precisa participar do handshake WebRTC mesmo sem jogar** — não existe um jeito de "opt-out"/sinalizar ao client real pra não esperar pelo host.

### Mensagens do broker (protocolo PeerJS)

Frames de texto JSON, todos vistos em captura real:

```jsonc
// Incoming — conexão pronta
{ "type": "OPEN" }

// Outgoing — proposta de conexão P2P (quem entra na sala oferta pra cada peer existente)
{
  "type": "OFFER",
  "payload": {
    "sdp": { "sdp": "v=0\r\no=- ...", "type": "offer" },
    "type": "data",
    "connectionId": "dc_usb7f3jh52",
    "browser": "chrome",
    "label": "dc_usb7f3jh52",
    "reliable": false,
    "serialization": "binary"
  },
  "dst": "<peerID do destinatário>"
}

// Incoming — resposta ao OFFER
{
  "type": "ANSWER",
  "src": "<peerID de quem respondeu>",
  "dst": "<meu peerID>",
  "payload": { "sdp": { "sdp": "v=0\r\no=- ...", "type": "answer" }, "type": "data", "connectionId": "dc_usb7f3jh52" }
}

// Incoming/Outgoing — troca de candidatos ICE (várias por conexão)
{
  "type": "CANDIDATE",
  "payload": {
    "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "..." },
    "type": "data",
    "connectionId": "dc_usb7f3jh52"
  },
  "dst": "<peerID>"
}

// Incoming — peer não respondeu ao OFFER a tempo (handshake nunca completou)
{ "type": "EXPIRE", "src": "<peerID que não respondeu>", "dst": "<meu peerID>" }

// Outgoing — keep-alive periódico (~5s)
{ "type": "HEARTBEAT" }
```

`serialization: "binary"` no `OFFER` indica que o DataChannel usa `binaryType` binário — na prática chega como `Blob` no navegador (não `ArrayBuffer` direto; é preciso setar `channel.binaryType = 'arraybuffer'` ou ler via `Blob.arrayBuffer()` pra inspecionar).

### DataChannel — formato binário customizado (parcialmente decodificado)

O payload trafegado pelo DataChannel (não pelo broker — isso é depois do handshake completo, canal peer-to-peer direto) é um formato binário compacto próprio, **não é JSON nem MessagePack padrão**. Exemplo real capturado (12 bytes, disparado por um evento de tecla):

```
83 b1 69 02 b1 66 cd 07 68 b1 63 00
```

Estrutura observada (comparando várias amostras consecutivas):

| Offset | Bytes | Papel observado |
|---|---|---|
| 0 | `83` | Constante — possível tipo/versão de packet |
| 1 | `b1` | Constante — marcador antes de cada campo |
| 2 | `69` | Constante — `'i'` (nome do campo 1) |
| 3 | *varia* | Valor do campo `i` — provavelmente bitmask de teclas pressionadas |
| 4 | `b1` | Constante — marcador |
| 5 | `66` | Constante — `'f'` (nome do campo 2) |
| 6 | `cd` | Constante — tag de uint16 big-endian |
| 7–8 | *varia* | Valor do campo `f` — contador incrementando ~30 unidades/segundo (tick a ~30Hz) |
| 9 | `b1` | Constante — marcador |
| 10 | `63` | Constante — `'c'` (nome do campo 3) |
| 11 | *varia* | Valor do campo `c` — contador sequencial, +1 por mensagem enviada |

**Confirmado (2026-09-18, jogadores reais):** o host/bot RECEBE esses frames pelo DataChannel. Um frame por evento de tecla (apertar ou soltar); jogador parado NÃO envia nada. `i` = estado das teclas: `0x02` (→), `0x04` (↑), `0x00` (soltou tudo) — outras teclas não mapeadas. Isso permite detectar inatividade sem rodar física: `BonkRoom` emite `peer-input` (`{playerId, peerID, data}`) mapeando o peerID do roster; ver `packages/core/src/room/AntiAfk.ts` (`room.enableAntiAfk()`) e `apps/bonk-room/examples/antiAfk.ts`. Requer as páginas dos jogadores em foreground (Chrome pausa jogo em aba de fundo).

**Não confirmado ainda:** o significado exato do campo `i` (bitmask de teclas?), se existem mais campos em mensagens maiores (ex: posição/velocidade), e — mais importante — **o formato da mensagem de "bootstrap" que o host manda pra um client recém-conectado**.

### Estado "awaiting first data" — o problema real do jogador tardio

O client tem uma etapa explícita no fluxo de conexão P2P (visível na UI: "Auto Joining... → P2P ready → Synchronized → Requesting to join room... → **Joined room, awaiting first data**"). Confirmado que:

- Um host real, mesmo **sozinho** (sem ninguém jogando), deixa um client novo passar dessa etapa — ou seja, o host manda *alguma* mensagem inicial pelo DataChannel só de ter um peer conectado, independente de haver partida ativa.
- O bonktools (mesmo já implementando o handshake completo — ver Pitfall 10 corrigido) **nunca envia nada** pelo DataChannel depois de aberto. Resultado: o client do jogador completa o handshake (sem `EXPIRE`) mas fica preso indefinidamente em "awaiting first data" / tela de lobby, porque nunca recebe o que está esperando.

**Isso ainda não foi capturado com certeza** (a mensagem de bootstrap do host real) — é o próximo passo pra resolver o bug do jogador tardio de forma completa.

### Fase B (frame de bootstrap neutro) — testada, NÃO resolve com jogadores reais ativos

Implementação: `PeerBrokerClient` manda um frame neutro no formato i/f/c (ver seção anterior)
pelo DataChannel assim que ele abre, pra cada peer que conecta no host.

**Teste real (2026-09-17)**: sala com bot host + 3 jogadores reais. `maxTeamSize=1`. Timeline:
1. PlayerX entra (id=1) → vira team 1 (host, sozinho).
2. New Player entra (id=2) → PickController monta 1v1 (PlayerX vs New Player), `GAME_START` disparado.
3. New Player2 entra (id=3) **enquanto o 1v1 já está ativo** → PickController corretamente
   força `team=0` (spectator) — como não sobra vaga, **nenhum `GAME_START`/`RETURN_TO_LOBBY`
   é disparado** para acomodar o 3º jogador (comportamento correto do PickController: só
   reorganiza times quando há vaga).
4. Confirmado no log: o handshake WebRTC do New Player2 com o host completa normalmente,
   zero `EXPIRE`, e o frame de bootstrap (Fase B) é enviado assim que o `DataChannel` abre.
5. **Resultado relatado pelo usuário: bug persiste.** New Player2 continua vendo só o lobby,
   mesmo com Fase A + Fase B funcionando tecnicamente sem erros.

**Conclusão**: a hipótese da Fase B ("qualquer mensagem do host destrava o client") estava
incompleta. O teste anterior que "confirmou" isso (host sozinho, sem partida ativa) não é
comparável — nesse caso o jogador que entra *se torna* o próprio jogo (vira participante,
não spectator observando outros). Já com uma partida real ativa entre OUTROS dois jogadores,
o bootstrap do host não é suficiente. Hipótese revisada: o cliente que assiste (spectator)
provavelmente precisa dos dados de física reais vindos das conexões WebRTC com os jogadores
ATIVOS (PlayerX ↔ New Player2, New Player ↔ New Player2) — que são peer-to-peer diretas entre
clients reais, fora do controle do bonktools. Ainda não sabemos se:
(a) os clients reais simplesmente não mandam nada pra um peer recém-conectado por padrão
    (bug/limitação do próprio bonk.io, não do bonktools), ou
(b) o host tem um papel de retransmissor: como está conectado a todos via malha completa,
    ele recebe a física dos jogadores ativos e deveria reencaminhar um snapshot pro
    recém-chegado — e o bonktools atualmente não lê nem retransmite nada recebido nos seus
    próprios DataChannels (`PeerBrokerClient` não tem handler de `channel.onmessage`).

**Não confirmado ainda**: não existe, até agora, nenhum teste-baseline com host 100% real
(navegador, sem bonktools) reproduzindo o mesmo cenário (3 jogadores reais, 3º entra com 1v1
já ativo) pra saber se esse bug é inerente ao bonk.io ou seria resolvido só com o bot
retransmitindo dados. Esse teste-baseline é o próximo passo mais informativo antes de
investir em qualquer relay de física.

---

## Team lock (packet 7) e `gs.tl` — congelamento dos jogadores

`TEAM_LOCK` (out 7, `{teamLock: bool}`) impede os jogadores de trocarem de time; só o host move (`CHANGE_OTHER_TEAM`, out 26). O servidor devolve `TEAMLOCK_TOGGLE` (in 19) também ao host, e limita a frequência (`rate_limit_tl`, status 16) — não repita o packet em rajada.

**Pitfall (validado com jogadores reais, 2026-09-18):** o campo `gs.tl` do `TRIGGER_START` (out 5) e do `INFORM_IN_GAME` (out 40) **precisa refletir o lock real da sala**. Com a sala travada e `gs.tl: false` (valor fixo que a lib mandava), a partida iniciava mas **ninguém conseguia se mover**: os discos ficavam parados no spawn, claros e sem nome, embora os clients continuassem enviando frames de input. Com `gs.tl` igual ao estado do lock, todos se movem normalmente. `BonkRoom` agora preenche `gs.tl` a partir de `state.teamsLocked`.

Método de diagnóstico (mede movimento de verdade, não só frames): comparar screenshots do campo antes/depois de segurar uma tecla; "frames de input chegando ao host" NÃO prova que o disco se move.

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

### Pitfall 10 — completar o handshake WebRTC não é suficiente pro jogador ver a partida

Um host headless que nunca implementou WebRTC/PeerJS (ver [Sincronização de partida](#sincronização-de-partida--webrtcpeerjs)) faz qualquer jogador que entra na sala ficar com uma conexão pra ele permanentemente pendente — o `OFFER` deles nunca é respondido e expira (`EXPIRE`). Isso por si só já impede o jogador de renderizar uma partida em andamento.

**Mas corrigir só isso (responder o handshake) não resolve o problema por completo.** Confirmado ao vivo: um host que completa o handshake (responde `ANSWER`, troca `CANDIDATE`, sem `EXPIRE`) mas nunca manda nada pelo DataChannel depois de aberto deixa o jogador preso em "awaiting first data" (ver seção acima) do mesmo jeito — só que sem o sintoma óbvio do `EXPIRE` pra apontar a causa. O host real manda alguma mensagem de bootstrap pelo DataChannel assim que um peer conecta, mesmo sem partida ativa — isso ainda precisa ser capturado e reproduzido.

**Lição:** ao debugar esse tipo de sintoma ("cliente conectado mas não sincroniza"), sempre confirmar tanto (a) o handshake de sinalização completou sem `EXPIRE` quanto (b) dados reais estão trafegando pelo canal depois de aberto — os dois podem falhar de forma independente e produzem o mesmo sintoma visível (jogador preso no lobby).

---

## URL das salas

```
https://bonk.io/<roomId><bypass>
```

- `roomId`: 6 dígitos numéricos
- `bypass`: 5 caracteres alfanuméricos opcionais (permite entrar sem senha)

Exemplo: `https://bonk.io/123456abcde`

O `roomId` e `bypass` são recebidos no packet **SHARE_LINK (incoming 49)** após criar a sala.
