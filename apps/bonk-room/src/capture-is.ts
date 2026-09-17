/**
 * capture-is.ts — utilitário one-shot para capturar o is blob de uma sala ao vivo.
 *
 * Uso:
 *   pnpm --filter bonk-room exec tsx src/capture-is.ts <URL_DA_SALA> [chave] [arquivo-saida.json]
 *
 * Exemplo (conta registrada, via .env):
 *   pnpm --filter bonk-room exec tsx src/capture-is.ts https://bonk.io/123456abcde
 *
 * Exemplo (guest, sem credenciais — define BONK_GUEST=1):
 *   BONK_GUEST=1 pnpm --filter bonk-room exec tsx src/capture-is.ts https://bonk.io/123456abcde vtol:2 blobs.json
 *
 * O script entra na sala como espectador e aguarda GAME_START.
 * Quando o host (você, no browser) iniciar o jogo, o is blob será exibido.
 * Se `chave` e `arquivo-saida` forem passados, o blob também é gravado em
 * arquivo-saida.json como { [chave]: blob }, acumulando entradas existentes —
 * útil para capturas em lote (múltiplos gamemodes/contagens de jogadores).
 */

import pino from 'pino';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { joinRoom, type AuthOptions } from '@bonktools/core';
import { authFromEnv } from './config.js';

const log = pino({ level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } });

const roomUrl = process.argv[2];
const outputKey = process.argv[3];
const outputFile = process.argv[4];

if (!roomUrl) {
  console.error('Uso: tsx src/capture-is.ts <URL_DA_SALA> [chave] [arquivo-saida.json]');
  console.error('Exemplo: BONK_GUEST=1 tsx src/capture-is.ts https://bonk.io/123456abcde vtol:2 blobs.json');
  process.exit(1);
}

const auth: AuthOptions = process.env.BONK_GUEST
  ? { type: 'guest', guestName: `Capture${Math.floor(Math.random() * 10000)}` }
  : authFromEnv();

log.info({ url: roomUrl, guest: auth.type === 'guest' }, 'entrando na sala como espectador...');

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

      if (outputKey && outputFile) {
        const existing: Record<string, string> = existsSync(outputFile)
          ? JSON.parse(readFileSync(outputFile, 'utf8')) as Record<string, string>
          : {};
        existing[outputKey] = isBlob;
        writeFileSync(outputFile, JSON.stringify(existing, null, 2));
        log.info({ outputFile, outputKey }, 'blob gravado no arquivo de saída');
      }
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
