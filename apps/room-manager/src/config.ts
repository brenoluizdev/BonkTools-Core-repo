// config.ts — validação zod do arquivo de salas (D-13 / RM-05) e leitura de credenciais do env.

import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { AuthOptions } from '@bonktools/core';

// ─── Schemas (D-13) ──────────────────────────────────────────────────────────

/** Configuração declarativa de uma sala. Campos opcionais recebem defaults aqui. */
const RoomConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  password: z.string().default(''),
  maxPlayers: z.number().int().min(1).max(8).default(6),
  mode: z.string().default('b'),
  rounds: z.number().int().min(1).default(3),
  hidden: z.boolean().default(false),
  map: z.string().optional(),
});

/** Token-bucket por conta — stagger entre criações de sala (RM-05 / D-09). */
const ThrottleSchema = z.object({
  maxConcurrentRooms: z.number().int().min(1).default(10),
  roomCreationDelayMs: z.number().int().min(0).default(3000),
  roomCreationJitterMs: z.number().int().min(0).default(2000),
});

export const RoomManagerConfigSchema = z.object({
  rooms: z.array(RoomConfigSchema).min(1),
  throttle: ThrottleSchema.default({}),
});

export type RoomManagerConfig = z.infer<typeof RoomManagerConfigSchema>;
export type RoomItemConfig = z.infer<typeof RoomConfigSchema>;

// ─── Loaders ─────────────────────────────────────────────────────────────────

/**
 * Lê e valida o rooms.json via zod antes de qualquer socket abrir (T-5-04-05).
 * Lança ZodError com mensagem clara se o arquivo não bater com o schema.
 */
export function loadConfig(path: string): RoomManagerConfig {
  return RoomManagerConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

// ASVS V7: NUNCA logar username/password. Retorna tipo opaco para BonkSession.
export function authFromEnv(): AuthOptions {
  const username = process.env.BONK_USERNAME;
  const password = process.env.BONK_PASSWORD;
  if (!username || !password) {
    throw new Error('BONK_USERNAME and BONK_PASSWORD must be set (see .env.example)');
  }
  return { type: 'registered', username, password };
}
