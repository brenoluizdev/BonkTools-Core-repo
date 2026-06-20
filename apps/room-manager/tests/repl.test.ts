import { describe, it, expect, vi, beforeEach } from 'vitest';
import type readline from 'node:readline';
import type { BonkSession } from '@bonktools/core';
import { startRepl } from '../src/repl.js';

type LineHandler = (input: string) => void | Promise<void>;

function makeMocks() {
  const addRoom = vi.fn(async () => 'local-id');
  const removeRoom = vi.fn(async () => {});
  const destroy = vi.fn(async () => {});
  const roomsMap = new Map<string, { room: unknown; status: string }>();

  const session = {
    addRoom,
    removeRoom,
    destroy,
    get rooms() {
      return roomsMap;
    },
  } as unknown as BonkSession;

  const onMock = vi.fn();
  const rl = {
    on: onMock,
    close: vi.fn(),
    prompt: vi.fn(),
  } as unknown as readline.Interface;

  startRepl(session, rl);
  // O handler de 'line' é o segundo argumento da primeira chamada a rl.on.
  const lineHandler = onMock.mock.calls[0]![1] as LineHandler;

  return { session, rl, lineHandler, roomsMap, addRoom, removeRoom };
}

describe('REPL — dispatch de comandos (RM-03)', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('list imprime entradas do session.rooms', async () => {
    const { lineHandler, roomsMap } = makeMocks();
    roomsMap.set('r1', { room: {}, status: 'active' });
    await lineHandler('list');
    expect(writeSpy).toHaveBeenCalled();
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('r1');
    expect(printed).toContain('active');
  });

  it('create chama session.addRoom com nome', async () => {
    const { lineHandler, addRoom } = makeMocks();
    await lineHandler('create Sala1');
    expect(addRoom).toHaveBeenCalledTimes(1);
    expect(addRoom.mock.calls[0]![0]).toMatchObject({ name: 'Sala1' });
  });

  it('create sem nome imprime erro e não chama addRoom', async () => {
    const { lineHandler, addRoom } = makeMocks();
    await lineHandler('create');
    expect(addRoom).not.toHaveBeenCalled();
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('create: nome obrigatório');
  });

  it('remove chama session.removeRoom com id', async () => {
    const { lineHandler, removeRoom } = makeMocks();
    await lineHandler('remove abc');
    expect(removeRoom).toHaveBeenCalledWith('abc');
  });

  it('comando desconhecido imprime mensagem de erro', async () => {
    const { lineHandler } = makeMocks();
    await lineHandler('xyzzy');
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Comando desconhecido');
  });

  it('help imprime lista de comandos', async () => {
    const { lineHandler } = makeMocks();
    await lineHandler('help');
    const printed = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('list');
    expect(printed).toContain('kick');
  });
});
