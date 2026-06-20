import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, authFromEnv, RoomManagerConfigSchema } from '../src/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function writeTempConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rm-config-'));
  const path = join(dir, 'rooms.json');
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return path;
}

describe('loadConfig — validação zod do rooms.json (D-13 / RM-05)', () => {
  it('loadConfig parse válido com campos obrigatórios', () => {
    const path = writeTempConfig({ rooms: [{ id: 'sala1', name: 'Sala 1' }] });
    const config = loadConfig(path);
    expect(config.rooms).toHaveLength(1);
    expect(config.rooms[0]!.id).toBe('sala1');
    expect(config.rooms[0]!.name).toBe('Sala 1');
    // defaults de RoomConfig
    expect(config.rooms[0]!.maxPlayers).toBe(6);
    expect(config.rooms[0]!.mode).toBe('b');
    expect(config.rooms[0]!.rounds).toBe(3);
    expect(config.rooms[0]!.hidden).toBe(false);
    expect(config.rooms[0]!.password).toBe('');
  });

  it('loadConfig aplica defaults de throttle quando ausente', () => {
    const path = writeTempConfig({ rooms: [{ id: 'sala1', name: 'Sala 1' }] });
    const config = loadConfig(path);
    expect(config.throttle.maxConcurrentRooms).toBe(10);
    expect(config.throttle.roomCreationDelayMs).toBe(3000);
    expect(config.throttle.roomCreationJitterMs).toBe(2000);
  });

  it('loadConfig rejeita quando rooms está vazio', () => {
    expect(() => RoomManagerConfigSchema.parse({ rooms: [] })).toThrow();
  });

  it('loadConfig rejeita quando id está ausente', () => {
    expect(() => RoomManagerConfigSchema.parse({ rooms: [{ name: 'x' }] })).toThrow();
  });
});

describe('authFromEnv — leitura de credenciais do env (ASVS V7)', () => {
  it('authFromEnv lança quando BONK_USERNAME ausente', () => {
    vi.stubEnv('BONK_USERNAME', '');
    vi.stubEnv('BONK_PASSWORD', 'pass');
    expect(() => authFromEnv()).toThrow('BONK_USERNAME and BONK_PASSWORD must be set');
  });

  it('authFromEnv retorna registered auth com username e password', () => {
    vi.stubEnv('BONK_USERNAME', 'user');
    vi.stubEnv('BONK_PASSWORD', 'pass');
    const auth = authFromEnv();
    expect(auth.type).toBe('registered');
    expect(auth).toMatchObject({ type: 'registered', username: 'user', password: 'pass' });
  });
});
