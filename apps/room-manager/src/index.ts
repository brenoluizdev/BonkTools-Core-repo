// index.ts — bootstrap Commander do room-manager: start --config, BonkSession, REPL, shutdown.
// ASVS V7: auth.password nunca logado. authFromEnv() lança se env ausente.

import { Command } from 'commander';
import readline from 'node:readline';
import { loadConfig, authFromEnv } from './config.js';
import { startRepl } from './repl.js';
import { BonkSession } from '@bonktools/core';

// Guard de módulo: evita múltiplos registros de listeners em chamadas repetidas (WR-04).
let shutdownRegistered = false;

/**
 * Instala handlers idempotentes de SIGTERM/SIGINT (RM-04).
 * Guard de módulo impede registro duplicado de listeners (WR-04).
 * Também ouve rl 'close' para que o comando 'exit' do REPL acione o shutdown (WR-01).
 */
export function installShutdown(session: BonkSession, rl: readline.Interface): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

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
  // WR-01: rl.close() (comando 'exit') aciona o mesmo handler de shutdown.
  rl.on('close', () => void handler());
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
    // CR-01: quando delayMs é 0, usa Infinity (sem throttle) em vez de 1/0.
    const delayMs = config.throttle.roomCreationDelayMs;
    const session = new BonkSession({
      auth,
      throttle: {
        capacity: config.throttle.maxConcurrentRooms,
        refillPerSec: delayMs > 0 ? 1 / (delayMs / 1000) : Infinity,
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
