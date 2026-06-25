import type { BonkRoom } from '@bonktools/core';
import { TEAM_SPEC, TEAM_FFA, TEAM_BLUE, TEAM_RED, TEAM_GREEN, TEAM_YELLOW } from '@bonktools/core';

export { TEAM_SPEC, TEAM_FFA, TEAM_BLUE, TEAM_RED, TEAM_GREEN, TEAM_YELLOW };

const TEAM_NAME: Record<number, string> = {
  0: 'spec', 1: 'ffa', 2: 'blue', 3: 'red', 4: 'green', 5: 'yellow',
};

export interface GamemodeSpec {
  engine: string;
  mode: string;
  teamCount: 2 | 4;
}

export const GAMEMODE_MAP: Record<string, GamemodeSpec> = {
  football:       { engine: 'f',   mode: 'f', teamCount: 2 },
  classic:        { engine: 'b',   mode: 'b', teamCount: 4 },
  arrows:         { engine: 'ar',  mode: 'b', teamCount: 4 },
  'death arrows': { engine: 'ard', mode: 'b', teamCount: 4 },
  grapple:        { engine: 'sp',  mode: 'b', teamCount: 4 },
  vtol:           { engine: 'v',   mode: 'b', teamCount: 4 },
};

const TEAMS_BY_COUNT: Record<2 | 4, number[]> = {
  // football: vermelho (3) primeiro = posição de campeão; azul (2) = desafiante
  2: [TEAM_RED, TEAM_BLUE],
  4: [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
};

export interface PickConfig {
  gamemode: string;
  engine: string;
  mode: string;
  maxTeamSize: number;
  rounds: number;
  /** Blob LZ-String fallback (legado / BONK_INITIAL_STATE). */
  initialState?: string;
  /** Blobs por jogadores ativos (excluindo bot): { "1": solo, "2": 1v1, "4": 2v2 }. */
  initialStates?: Record<string, string>;
}

export class PickController {
  private readonly room: BonkRoom;
  private readonly cfg: PickConfig;
  private readonly activeTeams: number[];
  private readonly isFootball: boolean;

  private static readonly PICK_TIMEOUT_MS = 30_000;

  private rosters = new Map<number, number[]>();
  private specQueue: number[] = [];
  private gameActive = false;
  private awaitingWinner = false;
  private winnerTimeout: NodeJS.Timeout | null = null;
  private pickMode = false;
  private pickTeam: number | null = null;
  private pickTimeout: NodeJS.Timeout | null = null;
  private lastJoinTime = 0;

  constructor(room: BonkRoom, cfg: PickConfig) {
    this.room = room;
    this.cfg = cfg;
    const spec = GAMEMODE_MAP[cfg.gamemode] ?? GAMEMODE_MAP['classic']!;
    this.activeTeams = TEAMS_BY_COUNT[spec.teamCount];
    this.isFootball = cfg.gamemode === 'football';
    this.resetState();
    this.attach();
    // Sala já ativa quando o controller foi criado: room-created/rebuilt já
    // dispararam antes do listener ser registrado (via session.on('room-added')).
    if (room.state.myId !== null) this.onRoomReady();
  }

  private resetState(): void {
    this.rosters = new Map(this.activeTeams.map(t => [t, []]));
    this.specQueue = [];
    this.gameActive = false;
    this.awaitingWinner = false;
    if (this.pickTimeout) { clearTimeout(this.pickTimeout); this.pickTimeout = null; }
    this.pickMode = false;
    this.pickTeam = null;
  }

  /** Move jogador para um time e registra log de movimentação. */
  private movePlayer(id: number, team: number): void {
    const name = this.room.state.players.get(id)?.userName ?? `id=${id}`;
    const teamName = TEAM_NAME[team] ?? String(team);
    process.stdout.write(`[LOG] [MOVE] ${name} > ${teamName}\n`);
    this.room.setTeam(id, team);
  }

  private enforceSpectator(): void {
    // Packet 6 (CHANGE_OWN_TEAM) com { targetTeam: 0 } — self-move correto.
    this.room.joinTeam(TEAM_SPEC);
    setTimeout(() => this.room.joinTeam(TEAM_SPEC), 500);
  }

  private onRoomReady(): void {
    // Ordem crítica: setTeamsEnabled ANTES de enforceSpectator.
    // O servidor pode redistribuir times ao processar o packet 32, sobrescrevendo
    // qualquer self-move anterior. enforceSpectator deve vir por ÚLTIMO.
    const r = this.room;
    r.setTeamsEnabled(true);
    r.setMode(this.cfg.engine, this.cfg.mode);
    r.setRounds(this.cfg.rounds);
    r.setReady(false);
    this.enforceSpectator();
  }

  private attach(): void {
    const r = this.room;

    r.on('room-created', () => this.onRoomReady());
    r.on('room-join',    () => this.onRoomReady());
    r.on('room-rebuilt', () => { this.resetState(); this.onRoomReady(); });

    // Snap-back: qualquer team-change no bot fora do spec → retorna imediatamente.
    // BLOQUEADO durante jogo ativo: enviar joinTeam durante partida pode abortar o jogo.
    r.on('team-change', (pkt) => {
      if (this.gameActive) return;
      const myId = r.state.myId;
      if (myId !== null && pkt.id === myId && pkt.team !== TEAM_SPEC) {
        this.room.joinTeam(TEAM_SPEC);
        setTimeout(() => this.room.joinTeam(TEAM_SPEC), 300);
      }
    });

    r.on('player-join', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.lastJoinTime = Date.now();
      const gameWasActive = this.gameActive;
      setTimeout(() => this.onPlayerJoin(pkt.id, gameWasActive), 400);
    });

    r.on('player-leave', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.onPlayerLeave(pkt.id);
    });

    r.on('game-start', () => {
      this.gameActive = true;
    });

    r.on('countdown', () => { /* passive — start direto via TRIGGER_START, sem countdown */ });

    r.on('game-end', () => {
      if (!this.gameActive) return;
      this.gameActive = false;
      // Detecta interrupção pelo servidor: novo jogador entrou há menos de 3s
      const interrupted = (Date.now() - this.lastJoinTime) < 3000;
      this.onGameEnd(interrupted);
    });

    r.on('chat-message', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.handleChat(pkt.message.trim(), pkt.id);
    });
  }

  private autoStart(): void {
    if (this.gameActive) return;
    if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
    this.awaitingWinner = false;
    // Re-aplica times do roster (servidor pode ter resetado após GAME_END)
    for (const [team, roster] of this.rosters) {
      for (const id of roster) { this.movePlayer(id, team); }
    }
    this.room.joinTeam(TEAM_SPEC);

    const myId = this.room.state.myId ?? 0;
    const bal: Record<number, number> = { [myId]: 0 };
    let bodyIdx = 1;
    for (const team of this.activeTeams) {
      for (const playerId of this.rosters.get(team)!) {
        bal[playerId] = bodyIdx++;
      }
    }

    // Chave = número de jogadores ativos (exclui bot): 1=solo, 2=1v1, 4=2v2
    const is = this.cfg.initialStates?.[String(bodyIdx - 1)] ?? this.cfg.initialState;
    const opts = is ? { is, gs: { bal } } : undefined;
    setTimeout(() => { if (!this.gameActive) this.room.startGame(opts); }, 300);
  }

  private onPlayerJoin(id: number, gameWasActive: boolean): void {
    if (id === this.room.state.myId) return;
    if (!this.room.state.players.has(id)) return;

    if (this.gameActive || gameWasActive) {
      const hasEmptyTeam = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) === 0);

      if (hasEmptyTeam) {
        // Time vazio (ex: solo ativo) — para, distribui novo jogador, reinicia
        const wasActive = this.gameActive;
        this.gameActive = false;
        this.awaitingWinner = false;
        if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
        // Só envia stopGame se o jogo ainda estava ativo do nosso ponto de vista.
        // Se game-end do servidor já chegou antes deste handler, não enviar novamente —
        // o servidor responderia com um game-end tardio que mataria o jogo recém-iniciado.
        if (wasActive) this.room.stopGame();
        this.assignToSlot(id);
        for (const team of this.activeTeams) { this.fillFromSpec(team); }
        const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
        if (anyFilled) setTimeout(() => this.autoStart(), 500);
        return;
      }

      // Verifica se novo jogador + spec completam todos os slots → para e redistribui
      const availableSlots = this.activeTeams.reduce(
        (sum, t) => sum + Math.max(0, this.cfg.maxTeamSize - (this.rosters.get(t)?.length ?? 0)),
        0,
      );
      if (availableSlots > 0 && this.specQueue.length + 1 >= availableSlots) {
        const wasActive = this.gameActive;
        this.gameActive = false;
        this.awaitingWinner = false;
        if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
        if (wasActive) this.room.stopGame();
        this.specQueue.push(id);
        for (const team of this.activeTeams) { this.fillFromSpec(team); }
        const allTeamsFull = this.activeTeams.every(t => (this.rosters.get(t)?.length ?? 0) >= this.cfg.maxTeamSize);
        if (allTeamsFull) setTimeout(() => this.autoStart(), 500);
        return;
      }

      // Slots insuficientes para completar — spec e continua
      this.specQueue.push(id);
      this.movePlayer(id, TEAM_SPEC);
      return;
    }

    this.assignToSlot(id);
    const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
    if (anyFilled) this.autoStart();
  }

  private assignToSlot(id: number): void {
    if (id === this.room.state.myId) return;
    // Pick the team with fewest players that still has space (balanced fill / round-robin)
    let bestTeam: number | null = null;
    let minSize = Infinity;
    for (const team of this.activeTeams) {
      const roster = this.rosters.get(team)!;
      if (roster.length < this.cfg.maxTeamSize && roster.length < minSize) {
        minSize = roster.length;
        bestTeam = team;
      }
    }
    if (bestTeam !== null) {
      this.rosters.get(bestTeam)!.push(id);
      this.movePlayer(id, bestTeam);
      return;
    }
    this.specQueue.push(id);
    this.movePlayer(id, TEAM_SPEC);
  }

  private onPlayerLeave(id: number): void {
    const si = this.specQueue.indexOf(id);
    if (si !== -1) {
      this.specQueue.splice(si, 1);
      if (this.pickMode && this.specQueue.length === 0) this.cancelPickMode();
      return;
    }

    for (const [team, roster] of this.rosters) {
      const ri = roster.indexOf(id);
      if (ri === -1) continue;
      roster.splice(ri, 1);

      if (this.pickMode) {
        // Já em pick mode: re-anuncia se spec ainda tem jogadores, senão cancela
        if (this.specQueue.length === 0 || (this.pickTeam === team && roster.length === 0)) {
          this.cancelPickMode();
        } else {
          this.announcePickList();
        }
        return;
      }

      if (!this.gameActive) {
        this.fillFromSpec(team);
        return;
      }

      // Jogo ativo: comportamento depende de maxTeamSize
      if (this.cfg.maxTeamSize === 1) {
        // Auto-reposição: para, puxa próximo da fila, reinicia
        this.stopGameState();
        this.fillFromSpec(team);
        const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
        if (anyFilled) setTimeout(() => this.autoStart(), 500);
      } else {
        // maxTeamSize >= 2: pick mode só se o time ainda tem capitão
        const hasCapt = (this.rosters.get(team)?.length ?? 0) > 0;
        if (this.specQueue.length > 0 && hasCapt) {
          this.activatePickMode(team);
        } else if (this.specQueue.length > 0) {
          // Time esvaziou — auto-fill sem capitão
          this.stopGameState();
          this.fillFromSpec(team);
          const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
          if (anyFilled) setTimeout(() => this.autoStart(), 500);
        } else {
          this.checkEmptyGame();
        }
      }
      return;
    }
  }

  // Para o jogo quando todos os jogadores ativos saem durante uma partida.
  // Sem isso, gameActive fica true e o próximo jogador que entra vai para SPEC.
  private checkEmptyGame(): void {
    const anyPlaying = [...this.rosters.values()].some(r => r.length > 0);
    if (anyPlaying) return;
    this.stopGameState();
  }

  private stopGameState(): void {
    this.room.stopGame();
    this.gameActive = false;
    this.awaitingWinner = false;
    if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
  }

  private activatePickMode(team: number): void {
    this.stopGameState();
    this.pickMode = true;
    this.pickTeam = team;
    this.announcePickList();
    this.pickTimeout = setTimeout(() => {
      if (this.pickMode) this.executePick(0);
    }, PickController.PICK_TIMEOUT_MS);
  }

  private announcePickList(): void {
    const captain = this.rosters.get(this.pickTeam!)?.[0];
    const captainName = captain !== undefined
      ? (this.room.state.players.get(captain)?.userName ?? `id=${captain}`)
      : '?';
    const list = this.specQueue
      .map((id, i) => `${i + 1} - ${this.room.state.players.get(id)?.userName ?? `id=${id}`}`)
      .join(', ');
    this.room.chat(`${captainName}, escolha: !pick <número>`);
    this.room.chat(`Disponíveis: ${list}`);
  }

  private executePick(index: number): void {
    if (this.pickTimeout) { clearTimeout(this.pickTimeout); this.pickTimeout = null; }
    this.pickMode = false;
    const pickedId = this.specQueue.splice(index, 1)[0]!;
    const team = this.pickTeam!;
    this.pickTeam = null;
    this.rosters.get(team)!.push(pickedId);
    this.movePlayer(pickedId, team);
    setTimeout(() => this.autoStart(), 500);
  }

  private cancelPickMode(): void {
    if (this.pickTimeout) { clearTimeout(this.pickTimeout); this.pickTimeout = null; }
    this.pickMode = false;
    this.pickTeam = null;
    this.checkEmptyGame();
  }

  private fillFromSpec(team: number): void {
    const roster = this.rosters.get(team)!;
    while (roster.length < this.cfg.maxTeamSize && this.specQueue.length > 0) {
      const next = this.specQueue.shift()!;
      if (this.room.state.players.has(next)) {
        roster.push(next);
        this.movePlayer(next, team);
      }
    }
  }

  private onGameEnd(interrupted = false): void {
    if (interrupted) {
      // Servidor interrompeu o jogo (novo jogador entrou) — reinicia sem rotação.
      // 600ms garante que o onPlayerJoin com delay de 400ms já executou antes do restart.
      setTimeout(() => this.autoStart(), 600);
      return;
    }
    if (!this.isFootball) {
      this.rotateChallengers();
      return;
    }
    this.awaitingWinner = true;
    this.room.chat('Fim de jogo! Quem venceu? !win blue ou !win red');
    this.winnerTimeout = setTimeout(() => {
      if (!this.awaitingWinner) return;
      this.resolveWinner(TEAM_BLUE);
    }, 20_000);
  }

  private handleChat(msg: string, senderId: number): void {
    const lower = msg.toLowerCase();
    if (lower === '!ping')  { this.room.chat('Pong!'); return; }
    if (lower === '!start') { this.handleStartCommand(); return; }
    if (lower === '!stop')  { this.handleStopCommand();  return; }

    if (this.pickMode) {
      const match = lower.match(/^!pick\s+(\d+)$/) ?? lower.match(/^(\d+)$/);
      if (match) {
        const captain = this.rosters.get(this.pickTeam!)?.[0];
        if (captain !== senderId) return;
        const idx = parseInt(match[1]!, 10) - 1;
        if (idx >= 0 && idx < this.specQueue.length) {
          this.executePick(idx);
        } else {
          this.room.chat(`Número inválido. Escolha entre 1 e ${this.specQueue.length}.`);
        }
      }
      return;
    }

    if (!this.awaitingWinner) return;
    if (lower === '!win blue') { this.resolveWinner(TEAM_BLUE); return; }
    if (lower === '!win red')  { this.resolveWinner(TEAM_RED);  return; }
  }

  private handleStartCommand(): void {
    if (this.gameActive) {
      const anyPlaying = [...this.rosters.values()].some(r => r.length > 0);
      if (anyPlaying) {
        this.room.chat('Partida já em andamento.');
        return;
      }
      this.room.stopGame();
      this.gameActive = false;
    }
    const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
    if (!anyFilled) {
      this.room.chat('Nenhum jogador em campo.');
      return;
    }
    this.autoStart();
  }

  private handleStopCommand(): void {
    if (!this.gameActive && !this.pickMode) {
      this.room.chat('Nenhuma partida em andamento.');
      return;
    }
    if (this.pickMode) { this.cancelPickMode(); return; }
    this.stopGameState();
  }

  private resolveWinner(winner: number): void {
    if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
    this.awaitingWinner = false;
    this.applyFootballRotation(winner);
  }

  private applyFootballRotation(winner: number): void {
    const champ      = this.activeTeams[0]!; // TEAM_RED=3 (slot 0 = campeão estabelecido, vermelho)
    const challenger = this.activeTeams[1]!; // TEAM_BLUE=2 (slot 1 = desafiante, azul)
    const champRoster  = [...this.rosters.get(champ)!];
    const challRoster  = [...this.rosters.get(challenger)!];

    if (winner === champ) {
      // Campeão (vermelho) vence: red fica, blue → spec, próximo da fila → blue
      this.rosters.set(challenger, []);
      for (const id of challRoster) {
        this.specQueue.push(id);
        this.movePlayer(id, TEAM_SPEC);
      }
      this.fillFromSpec(challenger);
    } else {
      // Desafiante (azul) vence: red → spec, blue vira red, próximo → blue
      this.rosters.set(champ, []);
      for (const id of champRoster) {
        this.specQueue.push(id);
        this.movePlayer(id, TEAM_SPEC);
      }
      this.rosters.set(champ, challRoster);
      this.rosters.set(challenger, []);
      for (const id of challRoster) {
        this.movePlayer(id, champ);
      }
      this.fillFromSpec(challenger);
    }

    const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
    if (anyFilled) setTimeout(() => this.autoStart(), 500);
  }

  private rotateChallengers(): void {
    for (const team of this.activeTeams.slice(1)) {
      const roster = [...this.rosters.get(team)!];
      this.rosters.set(team, []);
      for (const id of roster) {
        this.specQueue.push(id);
        this.movePlayer(id, TEAM_SPEC);
      }
      this.fillFromSpec(team);
    }
    const anyFilled = this.activeTeams.some(t => (this.rosters.get(t)?.length ?? 0) > 0);
    if (anyFilled) setTimeout(() => this.autoStart(), 500);
  }

  destroy(): void {
    if (this.winnerTimeout) { clearTimeout(this.winnerTimeout); this.winnerTimeout = null; }
    if (this.pickTimeout)   { clearTimeout(this.pickTimeout);   this.pickTimeout = null;   }
  }
}
