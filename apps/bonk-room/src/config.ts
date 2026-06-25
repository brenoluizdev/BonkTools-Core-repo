import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { AuthOptions } from '@bonktools/core';
import { FOOTBALL_DEFAULT_BLOBS } from '@bonktools/core';
import { GAMEMODE_MAP, type PickConfig } from './pick/PickController.js';


const RoomSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  password: z.string().default(''),
  maxPlayers: z.number().int().min(1).max(8).default(6),
  mode: z.string().default('b'),
  rounds: z.number().int().min(1).default(3),
  hidden: z.boolean().default(false),
  map: z.string().optional(),
});

const ThrottleSchema = z.object({
  maxConcurrentRooms: z.number().int().min(1).default(1),
  roomCreationDelayMs: z.number().int().min(0).default(3000),
  roomCreationJitterMs: z.number().int().min(0).default(2000),
});

export const AtlasConfigSchema = z.object({
  room: RoomSchema,
  throttle: ThrottleSchema.default({}),
  initialStates: z.record(z.string(), z.string()).optional().default({}),
});

export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

export function loadConfig(path: string): AtlasConfig {
  return AtlasConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function authFromEnv(): AuthOptions {
  const username = process.env.BONK_USERNAME;
  const password = process.env.BONK_PASSWORD;
  if (!username) throw new Error('BONK_USERNAME must be set (see .env.example)');
  if (!password) throw new Error('BONK_PASSWORD must be set (see .env.example)');
  return { type: 'registered', username, password };
}

export function pickConfigFromEnv(initialStates?: Record<string, string>): PickConfig {
  const gamemode = (process.env.BONK_GAMEMODE ?? 'football').toLowerCase();
  const spec = GAMEMODE_MAP[gamemode];
  if (!spec) {
    const valid = Object.keys(GAMEMODE_MAP).join(', ');
    throw new Error(`BONK_GAMEMODE inválido: "${gamemode}". Válidos: ${valid}`);
  }
  const maxTeamSize = parseInt(process.env.BONK_MAXTEAMSIZE ?? '1', 10);
  if (isNaN(maxTeamSize) || maxTeamSize < 1 || maxTeamSize > 8)
    throw new Error('BONK_MAXTEAMSIZE deve ser inteiro entre 1 e 8');
  const rounds = parseInt(process.env.BONK_ROUNDS ?? '3', 10);
  if (isNaN(rounds) || rounds < 1)
    throw new Error('BONK_ROUNDS deve ser inteiro >= 1');
  const initialState = process.env.BONK_INITIAL_STATE ?? undefined;
  const mergedInitialStates = initialStates ?? {};
  if (initialState) mergedInitialStates[String(maxTeamSize)] ??= initialState;
  // Para football, preenche automaticamente os blobs padrão para contagens sem blob definido.
  // O blob codifica posições de spawn por número de bodies (bot + jogadores ativos).
  // Usar o blob errado (ex: blob de 2 jogadores para partida 2v2) impede o jogo de iniciar.
  if (gamemode === 'football') {
    for (const [count, blob] of Object.entries(FOOTBALL_DEFAULT_BLOBS)) {
      mergedInitialStates[count] ??= blob;
    }
  }
  if (Object.keys(mergedInitialStates).length === 0) {
    process.stderr.write(
      '[WARN] Nenhum initialState configurado. ' +
      'O jogo iniciará com is="" e clientes não inicializarão a engine de física do football. ' +
      'Capture o blob: pnpm --filter bonk-room capture-is <URL_DA_SALA>\n',
    );
  }
  return {
    gamemode,
    engine: spec.engine,
    mode: spec.mode,
    maxTeamSize,
    rounds,
    ...(initialState ? { initialState } : {}),
    initialStates: mergedInitialStates,
  };
}
