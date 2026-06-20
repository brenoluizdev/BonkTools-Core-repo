// index.ts — bootstrap Commander do room-manager: start --config, BonkSession, REPL, shutdown.
// ASVS V7: auth.password nunca logado. authFromEnv() lança se env ausente.

import { Command } from 'commander';
import readline from 'node:readline';
import { loadConfig, authFromEnv } from './config.js';
import { startRepl } from './repl.js';
import { BonkSession } from '@bonktools/core';

/**
 * Instala handlers idempotentes de SIGTERM/SIGINT (RM-04).
 * Guard boolean garante uma única limpeza; fecha o readline, destrói a sessão e sai.
 */
export function installShutdown(session: BonkSession, rl: readline.Interface): void {
  let shuttingDown = false;
  const handler = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    rl.close();
    await session.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void handler());
  process.on('SIGINT', () => void handler());
}

const program = new Command();

program.name('room-manager').description('Gerencia salas bonk.io 24/7 via CLI');

program
  .command('start')
  .description('Inicia o room-manager com o arquivo de configuração')
  .requiredOption('--config <path>', 'Caminho para rooms.json')
  .action(async (opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const auth = authFromEnv();
    const session = new BonkSession({
      auth,
      throttle: {
        capacity: config.throttle.maxConcurrentRooms,
        refillPerSec: 1 / (config.throttle.roomCreationDelayMs / 1000),
      },
    });
    await session.getToken(auth);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });
    installShutdown(session, rl);
    await session.startFromConfig(config);
    startRepl(session, rl);
    rl.prompt();
  });

program.parse();
