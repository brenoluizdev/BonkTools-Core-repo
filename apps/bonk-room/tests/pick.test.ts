import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PickController } from '../src/pick/PickController.js';
import { FakeRoom, RED, BLUE } from './fakeRoom.js';

const INITIAL = { '1': 'b1', '2': 'b2', '4': 'b4', '6': 'b6' };

function setup(maxTeamSize: number, gamemode = 'football') {
  const room = new FakeRoom();
  const pick = new PickController(room.asRoom(), {
    gamemode, engine: 'f', mode: 'f', maxTeamSize, rounds: 3, initialStates: INITIAL,
  });
  return { room, pick };
}
const tick = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms);

/** Toda partida iniciada precisa ter times iguais, ≤ N, sem AFK e sem o bot. */
function assertStartsValid(room: FakeRoom, N: number, afk: Set<number> = new Set()): void {
  for (const s of room.starts) {
    const b = s.teams[BLUE]!.length;
    const r = s.teams[RED]!.length;
    expect(b, `azul acima de N: ${JSON.stringify(s.teams)}`).toBeLessThanOrEqual(N);
    expect(r, `vermelho acima de N: ${JSON.stringify(s.teams)}`).toBeLessThanOrEqual(N);
    if (s.total > 1) expect(b, `times desiguais ${b}v${r}`).toBe(r);
    for (const id of [...s.teams[BLUE]!, ...s.teams[RED]!]) expect(afk.has(id)).toBe(false);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PickController — fluxo do enunciado (maxTeamSize = 2)', () => {
  it('1º jogador → azul (solo), 2º → vermelho (1v1), 3º → spec sem interromper', async () => {
    const { room } = setup(2);
    room.join(1); await tick(3000);
    expect(room.teamOf(1)).toBe(BLUE);
    expect(room.starts.at(-1)!.total).toBe(1);

    room.join(2); await tick(3000);
    expect(room.teamOf(2)).toBe(RED);
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1], [RED]: [2] });

    const stopsBefore = room.stops;
    room.join(3); await tick(3000);
    expect(room.teamOf(3)).toBe(0);
    expect(room.stops).toBe(stopsBefore); // terceiro não interrompe a partida
    assertStartsValid(room, 2);
  });

  it('4º jogador → parte pára, capitão azul escolhe, o que sobra vai pro vermelho', async () => {
    const { room, pick } = setup(2);
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    room.join(4); await tick(1000);

    expect(room.stops).toBeGreaterThan(0);
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    expect(room.chats.some((c) => c.includes('P1 (blue), digite o número'))).toBe(true);
    expect(room.chats.at(-1)).toBe('Disponíveis: 1 - P3, 2 - P4');

    room.say(1, '1'); await tick(3000);
    expect(room.teamOf(3)).toBe(BLUE);
    expect(room.teamOf(4)).toBe(RED); // último candidato entra automaticamente
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1, 3], [RED]: [2, 4] });
    assertStartsValid(room, 2);
  });

  it('só o capitão escolhe; número inválido é recusado', async () => {
    const { room, pick } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    room.say(2, '1'); await tick(100); // vermelho não é capitão da vez
    room.say(3, '1'); await tick(100); // candidato também não
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    room.say(1, '9'); await tick(100);
    expect(room.chats.at(-1)).toContain('Número inválido');
    expect(pick.snapshot().pickTeam).toBe(BLUE);
  });

  it('o capitão escolhe só digitando o número, sem nenhum comando', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    expect(room.chats.some((c) => c.includes('digite o número'))).toBe(true);
    expect(room.chats.some((c) => c.includes('!pick'))).toBe(false); // a mensagem nem cita o comando
    room.say(1, '2'); await tick(3000);
    expect(room.teamOf(4)).toBe(BLUE); // escolheu o 2º da lista (P4)
    expect(room.teamOf(3)).toBe(RED); // o que sobrou vai pro vermelho
  });

  it('o comando !pick <n> continua funcionando como alias do número puro', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '!pick 2'); await tick(3000);
    expect(room.teamOf(4)).toBe(BLUE);
  });

  it('timeout de 30 s escolhe o primeiro da lista', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    await tick(31_000);
    expect(room.teamOf(3)).toBe(BLUE);
    expect(room.teamOf(4)).toBe(RED);
  });

  async function fullGame(room: FakeRoom, extra: number[] = [5]): Promise<void> {
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000); // azul: 1,3 | vermelho: 2,4
    for (const id of extra) { room.join(id); await tick(3000); } // spec
    room.gameRunning = true;
  }

  it('2x2 + 1 no spec: vermelho vence → azul inteiro vai pro spec, vermelho vira azul, 1º da fila vira capitão do vermelho e escolhe', async () => {
    const { room, pick } = setup(2);
    await fullGame(room);
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1, 3], [RED]: [2, 4] });
    expect(room.teamOf(5)).toBe(0);

    room.endGame(); await tick(100);
    expect(room.chats.at(-1)).toContain('Quem venceu');
    room.say(2, '!win red'); await tick(100);

    // vencedor (vermelho) → azul; perdedor → spec
    expect(room.teamOf(2)).toBe(BLUE);
    expect(room.teamOf(4)).toBe(BLUE);
    expect(room.teamOf(1)).toBe(0);
    expect(room.teamOf(3)).toBe(0);
    // 1º da fila (P5) é o capitão do vermelho e escolhe entre os perdedores
    expect(room.teamOf(5)).toBe(RED);
    expect(pick.snapshot().pickTeam).toBe(RED);
    expect(room.chats.some((c) => c.includes('P5 (red), digite o número'))).toBe(true);
    expect(room.chats.at(-1)).toBe('Disponíveis: 1 - P1, 2 - P3');

    room.say(5, '2'); await tick(3000);
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [2, 4], [RED]: [3, 5] });
    expect(room.teamOf(1)).toBe(0); // quem sobrou fica no spec
    assertStartsValid(room, 2);
  });

  it('azul vence → azul fica; vermelho inteiro pro spec; 1º da fila vira capitão do vermelho', async () => {
    const { room, pick } = setup(2);
    await fullGame(room);
    room.endGame(); await tick(100);
    room.say(1, '!win blue'); await tick(100);
    expect(room.teamOf(1)).toBe(BLUE);
    expect(room.teamOf(3)).toBe(BLUE);
    expect(room.teamOf(5)).toBe(RED);
    expect(pick.snapshot().pickTeam).toBe(RED);
    expect(room.chats.at(-1)).toBe('Disponíveis: 1 - P2, 2 - P4');
  });

  it('sem 5º jogador: perdedor volta inteiro; capitão = 1º da fila e o outro entra automático', async () => {
    const { room, pick } = setup(2);
    await fullGame(room, []);
    room.endGame(); await tick(100);
    room.say(1, '!win blue'); await tick(3000);
    expect(pick.snapshot().pickTeam).toBeNull(); // 1 candidato só: sem escolha real
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1, 3], [RED]: [2, 4] });
    assertStartsValid(room, 2);
  });

  it('!win só vale de jogador em campo (espectador não decide)', async () => {
    const { room } = setup(2);
    await fullGame(room);
    room.endGame(); await tick(100);
    room.say(5, '!win red'); await tick(100); // P5 é espectador
    expect(room.teamOf(1)).toBe(BLUE); // nada mudou
    room.say(2, '!win red'); await tick(100);
    expect(room.teamOf(2)).toBe(BLUE);
  });

  it('sem !win em 20 s o time azul (fixo) segue', async () => {
    const { room } = setup(2);
    await fullGame(room);
    room.endGame(); await tick(21_000);
    expect(room.teamOf(1)).toBe(BLUE);
    expect(room.teamOf(5)).toBe(RED);
  });
});

describe('Lock de times', () => {
  it('trava os times assim que a sala está pronta', () => {
    const { room } = setup(2);
    expect(room.locked).toBe(true);
  });
});

describe('AFK', () => {
  it('!afk alterna: mensagens exatas, vai pro spec e volta pra fila', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    room.say(3, '!afk'); await tick(100);
    expect(room.chats.at(-1)).toBe('o jogador P3 agora está afk!');
    room.say(3, '!afk'); await tick(100);
    expect(room.chats.at(-1)).toBe('o jogador P3 saiu do afk!');
  });

  it('jogador AFK não é candidato na escolha e não completa times', async () => {
    const { room, pick } = setup(2);
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    room.say(3, '!afk'); await tick(100);
    room.join(4); await tick(3000);
    // spec elegível = só P4 → 1v1 continua, sem escolha
    expect(pick.snapshot().pickTeam).toBeNull();
    room.join(5); await tick(1000);
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    expect(room.chats.at(-1)).toBe('Disponíveis: 1 - P4, 2 - P5'); // P3 (afk) fora da lista
    room.say(1, '1'); await tick(3000);
    assertStartsValid(room, 2, new Set([3]));
    expect(room.teamOf(3)).toBe(0);
  });

  it('em partida, jogador ativo NÃO pode ficar afk', async () => {
    const { room, pick } = setup(2);
    for (const id of [1, 2]) { room.join(id); await tick(3000); }
    room.gameRunning = true;
    room.say(2, '!afk'); await tick(100);
    expect(room.chats.at(-1)).toBe('P2, você está em partida e não pode ficar afk!');
    expect(room.teamOf(2)).toBe(RED);
    expect(pick.snapshot().afk).toEqual([]);
  });

  it('fora de partida (entre jogos) jogador ativo pode ficar afk: sai do time e a vaga é reposta', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000);
    room.gameRunning = true;
    room.endGame(); await tick(100); // aguardando vencedor (não é "em partida")
    const startsBefore = room.starts.length;
    room.say(4, '!afk'); await tick(100);
    expect(room.teamOf(4)).toBe(0);
    room.say(1, '!win blue'); await tick(3000);
    room.starts = room.starts.slice(startsBefore);
    assertStartsValid(room, 2, new Set([4]));
  });

  it('inatividade detectada em partida → AFK só ao fim da partida (e só se o sinal de movimento é confiável)', async () => {
    const { room } = setup(2);
    for (const id of [1, 2]) { room.join(id); await tick(3000); }
    room.gameRunning = true;
    room.emit('game-start', {});
    room.emit('peer-input', { playerId: 1 }); // há movimento na partida → sinal confiável
    room.emit('player-afk', 2); await tick(100);
    expect(room.teamOf(2)).toBe(RED); // durante a partida continua em campo
    room.endGame(); await tick(100);
    expect(room.teamOf(2)).toBe(0);
    expect(room.chats).toContain('o jogador P2 agora está afk!');
  });

  it('sem nenhum frame de movimento na partida, ninguém é punido (sinal indisponível)', async () => {
    const { room } = setup(2);
    for (const id of [1, 2]) { room.join(id); await tick(3000); }
    room.gameRunning = true;
    room.emit('game-start', {});
    room.emit('player-afk', 1); room.emit('player-afk', 2);
    room.endGame(); await tick(100);
    expect([room.teamOf(1), room.teamOf(2)]).toEqual([BLUE, RED]);
  });

  it('afk sai da lista ao deixar a sala (id reaproveitado não herda o afk)', async () => {
    const { room, pick } = setup(2);
    room.join(1); await tick(3000);
    room.join(3); room.join(2); await tick(3000);
    room.say(3, '!afk'); await tick(100);
    room.leave(3); await tick(100);
    expect(pick.snapshot().afk).toEqual([]);
    room.join(3); await tick(3000); // novo jogador com o mesmo id
    expect(pick.snapshot().afk).toEqual([]);
  });
});

describe('Gaps de proporção (nunca 2v1, 3v1, 3v4...)', () => {
  it('sai alguém no meio de 2x2 sem reposição → rebalanceia para 1v1 (sem 2v1)', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000);
    room.gameRunning = true;
    room.leave(4); await tick(3000);
    const last = room.starts.at(-1)!;
    expect(last.teams[BLUE]!.length).toBe(last.teams[RED]!.length);
    expect(last.total).toBe(2);
    assertStartsValid(room, 2);
  });

  it('sai alguém de 2x2 com espectador esperando → capitão escolhe/repõe e volta 2x2', async () => {
    const { room, pick } = setup(2);
    for (const id of [1, 2, 3, 4, 5]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000); // azul 1,3 | vermelho 2,4 | spec 5
    room.gameRunning = true;
    room.leave(4); await tick(3000);
    expect(pick.snapshot().pickTeam).toBeNull(); // único candidato entra sozinho
    expect(room.starts.at(-1)!.total).toBe(4);
    assertStartsValid(room, 2);
  });

  it('todo o time vermelho sai → azul se divide (capitão nos dois times) em vez de 2v0', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000);
    room.gameRunning = true;
    room.leave(2); room.leave(4); await tick(3000);
    assertStartsValid(room, 2);
    expect(room.starts.at(-1)!.total).toBe(2); // 1v1 com os dois que restaram
  });

  it('jogador troca de time sozinho no spec → revertido', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    await tick(2000);
    room.selfMove(3, BLUE); await tick(100);
    expect(room.teamOf(3)).toBe(0);
  });

  it('jogador em campo sai do time sozinho (spectate) → removido, partida reorganizada sem 2v1', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    room.say(1, '1'); await tick(3000);
    room.gameRunning = true;
    await tick(2000);
    room.selfMove(4, 0); await tick(3000);
    assertStartsValid(room, 2);
  });

  it('comandos !start/!stop só de jogadores em campo', async () => {
    const { room } = setup(2);
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    room.gameRunning = true;
    const stops = room.stops;
    room.say(3, '!stop'); await tick(100); // espectador
    expect(room.stops).toBe(stops);
    room.say(1, '!stop'); await tick(100);
    expect(room.stops).toBe(stops + 1);
  });

  it('!stop segura o reinício até o !start', async () => {
    const { room } = setup(2);
    for (const id of [1, 2]) { room.join(id); await tick(3000); }
    room.gameRunning = true;
    const before = room.starts.length;
    room.say(1, '!stop'); await tick(100);
    room.join(3); await tick(5000);
    expect(room.starts.length).toBe(before);
    room.say(1, '!start'); await tick(3000);
    expect(room.starts.length).toBe(before + 1);
  });
});

describe('maxTeamSize = 1 e 3', () => {
  it('N=1: 1v1; demais no spec; vencedor fica azul e o próximo da fila desafia', async () => {
    const { room } = setup(1);
    for (const id of [1, 2, 3, 4]) { room.join(id); await tick(3000); }
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1], [RED]: [2] });
    room.gameRunning = true;
    room.endGame(); await tick(100);
    room.say(2, '!win red'); await tick(3000);
    expect(room.teamOf(2)).toBe(BLUE); // vencedor sempre no azul
    expect(room.teamOf(3)).toBe(RED); // 1º da fila
    expect(room.teamOf(1)).toBe(0);
    assertStartsValid(room, 1);
  });

  it('N=3: 6 jogadores → capitães alternam escolhas (azul, vermelho, azul) e o último entra sozinho', async () => {
    const { room, pick } = setup(3);
    for (const id of [1, 2, 3, 4, 5, 6]) { room.join(id); await tick(3000); }
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    room.say(1, '1'); await tick(100); // azul leva P3
    expect(pick.snapshot().pickTeam).toBe(RED);
    room.say(2, '1'); await tick(100); // vermelho leva P4
    expect(pick.snapshot().pickTeam).toBe(BLUE);
    room.say(1, '1'); await tick(3000); // azul leva P5; P6 vai pro vermelho
    expect(room.starts.at(-1)!.teams).toEqual({ [BLUE]: [1, 3, 5], [RED]: [2, 4, 6] });
    assertStartsValid(room, 3);
  });

  it('N=3: 5 jogadores → 2v2 (nunca 3v2) com 1 no spec', async () => {
    const { room } = setup(3);
    for (const id of [1, 2, 3, 4, 5]) { room.join(id); await tick(3000); }
    await tick(65_000);
    assertStartsValid(room, 3);
    const last = room.starts.at(-1)!;
    expect(last.total).toBe(4);
  });
});

describe('Modo de 4 times (classic)', () => {
  it('N=1: cada jogador num time (azul, vermelho, verde, amarelo); o 5º espera no spec', async () => {
    const { room, pick } = setup(1, 'classic');
    for (const id of [1, 2, 3, 4, 5]) { room.join(id); await tick(3000); }
    const s = pick.snapshot();
    expect(Object.values(s.rosters).map((r) => r.length)).toEqual([1, 1, 1, 1]);
    expect(s.specQueue).toEqual([5]);
  });

  it('3 jogadores → 3 times de 1 (nunca um time de 2 contra dois de 1)', async () => {
    const { room, pick } = setup(2, 'classic');
    for (const id of [1, 2, 3]) { room.join(id); await tick(3000); }
    const sizes = Object.values(pick.snapshot().rosters).map((r) => r.length).filter((n) => n > 0);
    expect(sizes).toEqual([1, 1, 1]);
  });
});

// ─── Fuzz: sequências aleatórias com verificação de invariantes ─────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

describe('Fuzz de invariantes', () => {
  for (const N of [1, 2, 3]) {
    it(`N=${N}: 200 sequências aleatórias — toda partida iniciada é balanceada e sem AFK`, async () => {
      let totalStarts = 0, multi = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const { room, pick } = setup(N);
        const rand = rng(seed * 7919 + N);
        const nextId = { v: 1 };
        const afk = new Set<number>();
        const present = (): number[] => [...room.state.players.keys()].filter((i) => i !== 0);
        const pickOne = (a: number[]): number | undefined => a[Math.floor(rand() * a.length)];

        for (let step = 0; step < 40; step++) {
          const ids = present();
          const op = Math.floor(rand() * 10);
          if (op <= 2 && ids.length < 9) {
            const id = nextId.v++; room.join(id);
          } else if (op === 3) {
            const id = pickOne(ids); if (id !== undefined) { room.leave(id); afk.delete(id); }
          } else if (op === 4) {
            const id = pickOne(ids);
            if (id !== undefined) { room.say(id, '!afk'); }
          } else if (op === 5) {
            const snap = pick.snapshot();
            const cap = snap.pickTeam !== null ? snap.rosters[snap.pickTeam]?.[0] : undefined;
            if (cap !== undefined) room.say(cap, String(1 + Math.floor(rand() * 3)));
          } else if (op === 6) {
            room.endGame();
          } else if (op === 7) {
            const id = pickOne(ids);
            if (id !== undefined) room.say(id, rand() < 0.5 ? '!win blue' : '!win red');
          } else if (op === 8) {
            const id = pickOne(ids);
            if (id !== undefined) room.selfMove(id, [0, BLUE, RED][Math.floor(rand() * 3)]!);
          } else if (op === 9) {
            const id = pickOne(ids);
            if (id !== undefined && rand() < 0.3) room.say(id, rand() < 0.5 ? '!stop' : '!start');
          }
          await tick(Math.floor(rand() * 2500));
        }
        await tick(90_000); // deixa tudo assentar

        totalStarts += room.starts.length;
        multi += room.starts.filter((x) => x.total >= 2).length;
        // 1) toda partida iniciada foi válida
        const afkNow = new Set(pick.snapshot().afk);
        for (const s of room.starts) {
          const b = s.teams[BLUE]!.length, r = s.teams[RED]!.length;
          expect(b, `seed ${seed} N=${N}: ${JSON.stringify(s.teams)}`).toBeLessThanOrEqual(N);
          expect(r, `seed ${seed} N=${N}: ${JSON.stringify(s.teams)}`).toBeLessThanOrEqual(N);
          if (s.total > 1) expect(b, `seed ${seed} N=${N}: desigual ${b}v${r}`).toBe(r);
        }
        // 2) estado final coerente com o roster do controller
        const snap = pick.snapshot();
        const all = Object.values(snap.rosters).flat();
        expect(new Set(all).size, `seed ${seed}: jogador em 2 times`).toBe(all.length);
        for (const id of all) expect(afkNow.has(id), `seed ${seed}: afk em campo`).toBe(false);
        for (const [t, r] of Object.entries(snap.rosters)) {
          for (const id of r) expect(room.teamOf(id), `seed ${seed}: ${id} deveria estar em ${t}`).toBe(Number(t));
        }
        for (const id of [...snap.specQueue, ...snap.afk]) {
          expect(room.teamOf(id), `seed ${seed}: espectador ${id} fora do spec`).toBe(0);
        }
        pick.destroy();
      }
      // o fuzz precisa realmente exercitar partidas (não passar por vácuo)
      expect(totalStarts, `N=${N}: poucas partidas iniciadas`).toBeGreaterThan(300);
      expect(multi, `N=${N}: poucas partidas com 2+ jogadores`).toBeGreaterThan(150);
    }, 120_000);
  }
});
