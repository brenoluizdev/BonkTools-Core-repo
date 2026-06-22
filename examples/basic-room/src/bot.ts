/**
 * @bonktools/core — exemplo básico de bot bonk.io
 *
 * Demonstra o ciclo de vida completo de uma sala:
 *   1. Autenticação com conta registrada
 *   2. Criação de sala via createRoom()
 *   3. Escuta de todos os eventos relevantes
 *   4. Comandos de chat básicos (!start, !stop, !kick, !help)
 *   5. Shutdown gracioso (Ctrl+C / SIGTERM)
 *
 * COMO RODAR:
 *   cp .env.example .env        # preencha BONK_USERNAME e BONK_PASSWORD
 *   pnpm dev                    # roda com tsx (sem build)
 *   pnpm build && pnpm start    # ou compila e roda
 *
 * USANDO VIA NPM (fora do monorepo):
 *   npm install @bonktools/core
 *   # substitua "workspace:*" por "@bonktools/core": "^0.1.0" no package.json
 */

import { createRoom } from '@bonktools/core';
import type { RoomDeadReason } from '@bonktools/core';

// ── 1. Credenciais via variáveis de ambiente ─────────────────────────────────
//
// NUNCA coloque credenciais diretamente no código.
// Use um arquivo .env (gitignored) e carregue com --env-file=.env (Node 20+).

const username = process.env.BONK_USERNAME;
const password = process.env.BONK_PASSWORD;

if (!username || !password) {
  console.error('[bot] Erro: defina BONK_USERNAME e BONK_PASSWORD no arquivo .env');
  process.exit(1);
}

// ── 2. Criação da sala ────────────────────────────────────────────────────────
//
// createRoom() faz internamente:
//   - HTTP POST para login_legacy.php  → obtém token
//   - HTTP POST para getrooms.php      → descobre servidor
//   - Socket.IO connect (EIO=3)        → handshake
//   - Envia CREATE_ROOM (packet 12)    → aguarda SHARE_LINK (packet 49)
//
// Resolve com um BonkRoom já ativo. Rejeita com RoomCreationTimeoutError
// se o SHARE_LINK não chegar em 10 segundos.

console.log('[bot] Criando sala...');

const room = await createRoom({
  auth: {
    type: 'registered',
    username,
    password,
  },
  desiredState: {
    roomName: 'BonkTools Example',
    password: '',      // string vazia = sala sem senha
    maxPlayers: 6,     // 1–8
    mode: 'b',         // 'b'=classic  'ar'=arrows  'ard'=arrowsdeath  'sp'=simple
    rounds: 3,
  },
  hidden: false,       // true = sala não aparece na lista pública
  // reconnectPolicy: {
  //   maxAttempts:   10,     // default — tentativas antes de desistir
  //   initialDelayMs: 1000,  // default — delay inicial do backoff
  //   maxDelayMs:   30000,   // default — cap do backoff exponencial
  //   multiplier:     1.5,   // default
  //   jitter:         true,  // default — distribui reconexões para evitar thundering herd
  // },
});

console.log(`[bot] Sala criada! Link: ${room.shareLink}`);

// ── 3. Eventos do roster ──────────────────────────────────────────────────────
//
// room.state é sempre atualizado ANTES de cada emit — pode ser lido
// com segurança dentro dos handlers.

room.on('room-join', (packet) => {
  // Emitido quando o BOT MESMO entra/reentra em uma sala existente (joinRoom).
  // Para createRoom, apenas 'room-created' é emitido — sem 'room-join'.
  console.log(`[sala] Bot entrou | myId=${packet.myId} hostId=${packet.hostId}`);
});

room.on('room-created', () => {
  // Emitido apenas em createRoom(). O bot é automaticamente o host (id=0).
  console.log(`[sala] Sala criada pelo bot`);
});

room.on('player-join', (packet) => {
  const { userName, id, level, guest } = packet;
  console.log(`[+] ${userName} entrou (id=${id} level=${level} guest=${guest})`);

  // Mensagem de boas-vindas
  room.chat(`Bem-vindo(a), ${userName}! Digite !help para ver os comandos.`);

  // room.state.myId === room.state.hostId → bot é o host
  const { myId, hostId } = room.state;
  console.log(`    bot é host? myId=${myId} hostId=${hostId} → ${myId === hostId}`);
});

room.on('player-leave', (packet) => {
  console.log(`[-] Jogador id=${packet.id} saiu`);
});

room.on('host-leave', (packet) => {
  // newHostId === -1 indica que a sala foi fechada (host era o único)
  console.log(`[host] Host antigo=${packet.oldHostId} novo=${packet.newHostId}`);
});

room.on('team-change', (packet) => {
  const nome = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
  // times: 0=spec 1=ffa 2=vermelho 3=azul 4=verde 5=amarelo
  console.log(`[time] ${nome} → time ${packet.team}`);
});

room.on('ready-change', (packet) => {
  const nome = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
  console.log(`[ready] ${nome} → ${packet.ready}`);
});

// ── 4. Eventos de partida ─────────────────────────────────────────────────────

room.on('game-start', () => {
  console.log('[jogo] Partida iniciada');
});

room.on('game-end', () => {
  console.log('[jogo] Partida encerrada');
  room.chat('GG! Digite !start para jogar de novo.');
});

room.on('countdown', (packet) => {
  console.log(`[countdown] ${packet.n}s`);
});

room.on('abort-countdown', () => {
  console.log('[countdown] Abortado');
});

// ── 5. Chat e comandos ────────────────────────────────────────────────────────
//
// BonkRoom filtra automaticamente o echo do próprio bot:
// mensagens onde packet.id === room.state.myId NÃO emitem 'chat-message'.

room.on('chat-message', (packet) => {
  const player = room.state.players.get(packet.id);
  const nome = player?.userName ?? `id=${packet.id}`;
  console.log(`[chat] ${nome}: ${packet.message}`);

  const msg = packet.message.trim().toLowerCase();

  // !help — lista comandos disponíveis
  if (msg === '!help') {
    room.chat('Comandos: !start | !stop | !countdown | !kick <nome> | !link | !help');
    return;
  }

  // !link — imprime o link da sala no chat
  if (msg === '!link') {
    room.chat(`Link: ${room.shareLink ?? 'aguardando...'}`);
    return;
  }

  // !start — inicia a partida imediatamente
  if (msg === '!start') {
    room.startGame();
    return;
  }

  // !stop — volta todos ao lobby
  if (msg === '!stop') {
    room.stopGame();
    room.chat('Voltando ao lobby.');
    return;
  }

  // !countdown — inicia contagem regressiva de 3s
  if (msg === '!countdown') {
    room.startCountdown(3);
    return;
  }

  // !kick <nome> — kicka jogador por nome (case-insensitive)
  if (msg.startsWith('!kick ')) {
    const alvo = msg.slice(6).trim();
    let encontrado = false;
    for (const [, p] of room.state.players) {
      if (p.userName.toLowerCase() === alvo) {
        room.kickPlayer(p.id);
        room.chat(`${p.userName} foi kickado.`);
        encontrado = true;
        break;
      }
    }
    if (!encontrado) {
      room.chat(`Jogador "${alvo}" não encontrado.`);
    }
    return;
  }
});

// ── 6. Moderação ──────────────────────────────────────────────────────────────

room.on('player-kick', (packet) => {
  const nome = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
  console.log(`[kick] ${nome} foi kickado`);
});

// ── 7. Status e diagnóstico ───────────────────────────────────────────────────

room.on('status-message', (packet) => {
  // Exemplos de status: 'banned', 'room_full', 'xpb', 'gamelimit'
  console.log(`[status] ${packet.status}`);
});

room.on('share-link', (packet) => {
  // Emitido ao criar/recriar sala. room.shareLink já estará populado aqui.
  console.log(`[link] https://bonk.io/${packet.roomId}${packet.bypass}`);
});

// ── 8. Reconexão automática ───────────────────────────────────────────────────
//
// BonkRoom gerencia reconexão internamente com backoff exponencial.
// Falhas terminais (ban, sala cheia, retries esgotados) não reconectam.

room.on('room-dead', (reason: RoomDeadReason) => {
  console.warn('[sala] Sala morreu:', reason);
  // kind === 'socket-disconnect' → BonkRoom tentará reconectar automaticamente
  // kind === 'status-banned'     → ban permanente, sem retry
  // kind === 'status-room_full'  → sala cheia no momento de (re)conexão
  // kind === 'max-retries-exceeded' → esgotou tentativas de reconexão
});

room.on('room-rebuilt', (shareLink) => {
  console.log(`[sala] Reconectado: ${shareLink}`);
  room.chat('Bot reconectado!');
});

// ── 9. Pacotes desconhecidos ──────────────────────────────────────────────────
//
// 'raw-packet' é emitido para TODOS os packets antes de qualquer reducer.
// Útil para depurar packets ainda não mapeados pela lib.

room.on('raw-packet', (packet) => {
  if (packet.type === 'UNKNOWN') {
    console.debug('[raw] Packet desconhecido:', JSON.stringify((packet as { raw: unknown }).raw));
  }
});

// ── 10. Shutdown gracioso ─────────────────────────────────────────────────────

let encerrando = false;
const shutdown = (): void => {
  if (encerrando) return;
  encerrando = true;
  console.log('\n[bot] Encerrando...');
  room.disconnect(); // idempotente — limpa socket e timers
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);  // Ctrl+C
