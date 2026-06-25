/**
 * capture-is.ts — utilitário one-shot para capturar o is blob de uma sala football.
 *
 * Uso:
 *   pnpm --filter atlas tsx src/capture-is.ts <URL_DA_SALA>
 *
 * Exemplo:
 *   pnpm --filter atlas tsx src/capture-is.ts https://bonk.io/123456abcde
 *
 * O script entra na sala como espectador e aguarda GAME_START.
 * Quando o host (você, no browser) iniciar o jogo, o is blob será exibido.
 * Copie o valor de BONK_INITIAL_STATE para o .env do atlas.
 */

import pino from 'pino';
import { joinRoom } from '@bonktools/core';
import { authFromEnv } from './config.js';

const log = pino({ level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } });

const roomUrl = process.argv[2];
if (!roomUrl) {
  console.error('Uso: tsx src/capture-is.ts <URL_DA_SALA>');
  console.error('Exemplo: tsx src/capture-is.ts https://bonk.io/123456abcde');
  process.exit(1);
}

const auth = authFromEnv();

log.info({ url: roomUrl }, 'entrando na sala como espectador...');

const room = await joinRoom(roomUrl, {
  auth,
  role: 'spectator',
  logger: log,
});

log.info('na sala — aguardando GAME_START. Inicie o jogo no browser como host.');

await new Promise<void>((resolve) => {
  room.on('game-start', (pkt) => {
    const isBlob = typeof pkt.is === 'string' ? pkt.is : '';
    if (isBlob.length > 0) {
      console.log('\n========== COPIE ESTA LINHA PARA O .env ==========');
      console.log(`BONK_INITIAL_STATE=${isBlob}`);
      console.log('====================================================\n');
      log.info({ isLen: isBlob.length }, 'is blob capturado com sucesso');
    } else {
      log.warn('GAME_START recebido mas is está vazio — o host iniciou com blob inválido');
    }
    resolve();
  });

  room.on('room-dead', (reason) => {
    log.error({ reason }, 'sala morreu antes do game-start');
    resolve();
  });
});

room.disconnect();
process.exit(0);
