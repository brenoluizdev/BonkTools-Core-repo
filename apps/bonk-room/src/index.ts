import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { BonkSession } from '@bonktools/core';
import type { BonkRoom } from '@bonktools/core';
import { loadConfig, authFromEnv, pickConfigFromEnv } from './config.js';
import { AtlasBot } from './AtlasBot.js';

// ── Logger ────────────────────────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production';

const log = pino(
  isDev
    ? { level: 'debug', transport: { target: 'pino-pretty', options: { colorize: true } } }
    : { level: 'info' },
);

// ── Config ────────────────────────────────────────────────────────────────────

const config = loadConfig(fileURLToPath(new URL('../bonk-room.json', import.meta.url)));
const auth = authFromEnv();
const pickCfg = pickConfigFromEnv(config.initialStates);

log.info({ room: config.room.name }, 'bonk-room iniciando');

// ── Session ────────────────────────────────────────────────────────────────────
//
// BonkSession garante que a sala permaneça ativa 24h:
// - Se a sala morrer por causa transitória, recriam automaticamente
// - Reconcile loop de 60s como rede de segurança
// - Token compartilhado (uma autenticação para todas as salas)

const delayMs = config.throttle.roomCreationDelayMs;

const session = new BonkSession({
  auth,
  throttle: {
    capacity: config.throttle.maxConcurrentRooms,
    refillPerSec: delayMs > 0 ? 1 / (delayMs / 1000) : Infinity,
  },
  logger: log,
});

session.on('room-added', (localId) => {
  const entry = session.rooms.get(localId);
  if (!entry) return;

  log.info({ localId, shareLink: entry.room.shareLink }, 'sala adicionada ao pool');
  new AtlasBot(entry.room as BonkRoom, log, pickCfg);
});

session.on('room-dead-terminal', ({ localId, reason }) => {
  log.error({ localId, reason }, 'sala morreu permanentemente — ação manual necessária');
});

// ── Startup ───────────────────────────────────────────────────────────────────

await session.getToken(auth);

// exactOptionalPropertyTypes: campos opcionais undefined devem ser omitidos
const roomConfig = {
  id: config.room.id,
  name: config.room.name,
  password: config.room.password,
  maxPlayers: config.room.maxPlayers,
  mode: config.room.mode,
  rounds: config.room.rounds,
  hidden: config.room.hidden,
  ...(config.room.map !== undefined ? { map: config.room.map } : {}),
};

await session.startFromConfig({
  rooms: [roomConfig],
  throttle: config.throttle,
});

log.info('bonk-room pronto');

// ── Shutdown gracioso ─────────────────────────────────────────────────────────

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('encerrando...');
  await session.destroy();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
