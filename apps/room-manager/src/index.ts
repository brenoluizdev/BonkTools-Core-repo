// index.ts — bootstrap Commander do room-manager: start --config, BonkSession, REPL, shutdown.
// ASVS V7: auth.password nunca logado. authFromEnv() lança se env ausente.

import { Command } from 'commander';
import readline from 'node:readline';
import { loadConfig, authFromEnv, pickConfigFromEnv } from './config.js';
import { startRepl } from './repl.js';
import { BonkSession, BonkRoom } from '@bonktools/core';
import { PickController } from './pick/PickController.js';

// Guard de módulo: evita múltiplos registros de listeners em chamadas repetidas (WR-04).
let shutdownRegistered = false;

function log(roomLabel: string, msg: string): void {
  const ts = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
  process.stdout.write(`[${ts}] [${roomLabel}] ${msg}\n`);
}

/** Anexa listeners de observabilidade a uma BonkRoom. */
function watchRoom(room: BonkRoom, roomLabel: string): void {
  room.on('room-created', () => {
    log(roomLabel, `SALA CRIADA | myId=${room.state.myId}`);
  });

  room.on('share-link', (packet) => {
    log(roomLabel, `SHARE LINK: https://bonk.io/${packet.roomId}${packet.bypass}`);
  });

  room.on('player-join', (packet) => {
    log(roomLabel, `ENTROU: "${packet.userName}" (id=${packet.id} guest=${packet.guest})`);
  });

  room.on('player-leave', (packet) => {
    const name = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
    log(roomLabel, `SAIU: "${name}"`);
  });

  room.on('chat-message', (packet) => {
    const name = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
    log(roomLabel, `CHAT [${name}]: ${packet.message}`);
  });

  room.on('status-message', (packet) => {
    log(roomLabel, `STATUS: "${packet.status}"`);
  });

  room.on('room-dead', (reason) => {
    log(roomLabel, `SALA MORREU: ${JSON.stringify(reason)}`);
  });

  room.on('room-rebuilt', (link) => {
    log(roomLabel, `SALA RECRIADA: ${link}`);
  });

  room.on('game-start', () => {
    log(roomLabel, `JOGO INICIADO`);
  });

  room.on('game-end', () => {
    log(roomLabel, `JOGO ENCERRADO`);
  });

  room.on('team-change', (packet) => {
    const name = room.state.players.get(packet.id)?.userName ?? `id=${packet.id}`;
    log(roomLabel, `TIME: "${name}" => ${packet.team}`);
  });

  room.on('raw-packet', (packet) => {
    if (packet.type === 'UNKNOWN') {
      log(roomLabel, `PACKET DESCONHECIDO: ${JSON.stringify((packet as { type: string; raw: unknown }).raw)}`);
    }
  });
}

/**
 * Instala handlers idempotentes de SIGTERM/SIGINT (RM-04).
 * Guard de módulo impede registro duplicado de listeners (WR-04).
 * Também ouve rl 'close' para que o comando 'exit' do REPL acione o shutdown (WR-01).
 */
export function installShutdown(
  session: BonkSession,
  rl: readline.Interface,
  pickControllers: PickController[],
): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  let shuttingDown = false;
  const handler = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const ctrl of pickControllers) ctrl.destroy();
    rl.close();
    await session.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void handler());
  process.on('SIGINT',  () => void handler());
  // WR-01: rl.close() (comando 'exit') aciona o mesmo handler de shutdown.
  rl.on('close', () => void handler());
}

const program = new Command();

program.name('room-manager').description('Gerencia salas bonk.io 24/7 via CLI');

program
  .command('start')
  .description('Inicia o room-manager com o arquivo de configuração')
  .option('--config <path>', 'Caminho para rooms.json', 'rooms.example.json')
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const auth = authFromEnv();
    const pickCfg = pickConfigFromEnv();

    const delayMs = config.throttle.roomCreationDelayMs;
    const session = new BonkSession({
      auth,
      throttle: {
        capacity: config.throttle.maxConcurrentRooms,
        refillPerSec: delayMs > 0 ? 1 / (delayMs / 1000) : Infinity,
      },
    });

    const pickControllers: PickController[] = [];

    // Instala PickController em cada sala ao ser adicionada ao pool.
    session.on('room-added', (localId) => {
      const entry = session.rooms.get(localId);
      if (entry) {
        const label = entry.config.name.substring(0, 16);
        process.stdout.write(`[SESSION] Sala adicionada: ${localId} ("${entry.config.name}")\n`);
        watchRoom(entry.room, label);
        const ctrl = new PickController(entry.room, pickCfg);
        pickControllers.push(ctrl);
      }
    });

    session.on('room-dead-terminal', ({ localId, reason }) => {
      process.stdout.write(`[SESSION] Sala ${localId} TERMINAL: ${JSON.stringify(reason)}\n`);
    });

    await session.getToken(auth);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });
    installShutdown(session, rl, pickControllers);
    await session.startFromConfig(config);
    startRepl(session, rl);
    rl.prompt();
  });

program.parse();
