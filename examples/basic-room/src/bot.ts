/**
 * @bonktools/core — exemplo básico: sala de football
 *
 * Demonstra o mínimo necessário para criar uma sala funcional:
 *   1. Autenticação com conta registrada
 *   2. Criação de sala no modo football
 *   3. Iniciar partida com IS blob (obrigatório para football)
 *   4. Comando !ping no chat
 *   5. Shutdown gracioso
 *
 * COMO RODAR:
 *   cp .env.example .env        # preencha as variáveis
 *   pnpm dev                    # roda com tsx (sem build)
 *   pnpm build && pnpm start    # ou compila e roda
 */

import { createRoom } from '@bonktools/core';
import type { RoomDeadReason } from '@bonktools/core';

// ── Credenciais e configuração via variáveis de ambiente ──────────────────────
//
// NUNCA coloque credenciais ou blobs diretamente no código.
// Use .env (gitignored) e carregue com --env-file=.env (Node 20+).

const username = process.env.BONK_USERNAME;
const password = process.env.BONK_PASSWORD;

// BONK_INITIAL_STATE: blob LZ-String capturado de uma sessão real do bonk.io.
//
// O football EXIGE este blob — sem ele o servidor ecoa is="" no GAME_START e
// os clientes não inicializam a engine de física (jogadores não aparecem em campo).
//
// Como capturar:
//   1. Abra bonk.io no browser, crie uma sala de football como host
//   2. Adicione jogadores suficientes para o formato desejado e inicie o jogo
//   3. Abra o DevTools (F12) → Network → WebSocket → procure o frame
//      42[5, {"is": "<blob>", ...}]  (TRIGGER_START, outgoing)
//   4. Copie o valor de "is" e cole em BONK_INITIAL_STATE no seu .env
//
// O blob não contém IDs — pode ser reutilizado entre partidas.
// Cada configuração de jogadores (1v1, 2v2, etc.) precisa do seu próprio blob.
const initialState = process.env.BONK_INITIAL_STATE;

if (!username || !password) {
  console.error('Erro: defina BONK_USERNAME e BONK_PASSWORD no .env');
  process.exit(1);
}

if (!initialState) {
  console.warn(
    '[WARN] BONK_INITIAL_STATE não definido — partidas de football não funcionarão corretamente.\n' +
    '       Consulte os comentários acima para saber como capturar o blob.',
  );
}

// ── Criar sala ────────────────────────────────────────────────────────────────

console.log('Criando sala...');

const room = await createRoom({
  auth: { type: 'registered', username, password },
  desiredState: {
    roomName:   'BonkTools Example',
    password:   '',
    maxPlayers: 6,
    mode:       'f',   // 'f' = football
    rounds:     3,
    // engine é derivado automaticamente de mode. Para outros modos:
    // 'b'=classic  'ar'=arrows  'ard'=arrowsdeath  'sp'=grapple  'v'=vtol
  },
  hidden: false,
});

console.log(`Sala criada! Link: ${room.shareLink}`);

// ── Eventos ───────────────────────────────────────────────────────────────────

room.on('player-join', (pkt) => {
  console.log(`[+] ${pkt.userName} entrou (id=${pkt.id})`);
});

room.on('player-leave', (pkt) => {
  const name = room.state.players.get(pkt.id)?.userName ?? `id=${pkt.id}`;
  console.log(`[-] ${name} saiu`);
});

room.on('game-start', () => console.log('[jogo] Partida iniciada'));
room.on('game-end',   () => console.log('[jogo] Partida encerrada'));

room.on('share-link', (pkt) => {
  console.log(`[link] https://bonk.io/${pkt.roomId}${pkt.bypass}`);
});

room.on('room-dead', (reason: RoomDeadReason) => {
  console.warn('[sala] Sala morreu:', reason);
});

room.on('room-rebuilt', (shareLink) => {
  console.log(`[sala] Reconectado: ${shareLink}`);
});

// ── Chat ──────────────────────────────────────────────────────────────────────

room.on('chat-message', (pkt) => {
  const name = room.state.players.get(pkt.id)?.userName ?? `id=${pkt.id}`;
  const msg = pkt.message.trim().toLowerCase();
  console.log(`[chat] ${name}: ${pkt.message}`);

  if (msg === '!ping') {
    room.chat('Pong!');
    return;
  }

  // !start — inicia partida com IS blob (obrigatório para football).
  //
  // Para football competitivo com múltiplos jogadores, você pode calcular
  // o mapeamento explícito de bro bodies (bal) para garantir que cada
  // jogador receba a posição correta no campo, independente de ID gaps:
  //
  //   const bal: Record<number, number> = { [botId]: 0 };
  //   let bodyIdx = 1;
  //   for (const [playerId] of room.state.players) {
  //     if (playerId !== room.state.myId) bal[playerId] = bodyIdx++;
  //   }
  //   room.startGame({ is: initialState, gs: { bal } });
  //
  // Para um bot com lógica de pick de times, veja apps/bonk-room no repositório.
  if (msg === '!start') {
    room.startGame(initialState ? { is: initialState } : undefined);
    return;
  }
});

// ── Shutdown gracioso ─────────────────────────────────────────────────────────

let encerrando = false;
const shutdown = (): void => {
  if (encerrando) return;
  encerrando = true;
  console.log('\nEncerrando...');
  room.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
