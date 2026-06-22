import type { BonkRoom } from '@bonktools/core';

export const TEAM_SPEC   = 0;
export const TEAM_FFA    = 1;
export const TEAM_RED    = 2;
export const TEAM_BLUE   = 3;
export const TEAM_GREEN  = 4;
export const TEAM_YELLOW = 5;

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
  2: [TEAM_BLUE, TEAM_RED],
  4: [TEAM_BLUE, TEAM_RED, TEAM_GREEN, TEAM_YELLOW],
};

export interface PickConfig {
  gamemode: string;
  engine: string;
  mode: string;
  maxTeamSize: number;
  rounds: number;
}

/**
 * PickController — gerencia distribuição de jogadores entre times.
 *
 * Design inspirado no Futhero-bonk-rooms, adaptado para BonkTools-core:
 * - Estado interno (rosters + specQueue) é a fonte de verdade
 * - applyAssignments() sincroniza o estado interno com o servidor via setTeam
 * - Guarda reativa via 'team-change': qualquer mudança de time do bot pelo servidor
 *   é revertida imediatamente para spec
 * - setupRoom() envia setTeamsEnabled ANTES de setTeam(bot, spec), garantindo que
 *   a ativação de times não sobrescreva a posição do bot
 */
export class PickController {
  private readonly activeTeams: number[];
  private readonly isFootball: boolean;

  // Estado interno (fonte de verdade para times)
  private rosters = new Map<number, number[]>(); // team → [playerIds, FIFO]
  private specQueue: number[] = [];              // fila de espera, FIFO

  // Estado da partida
  private gameActive = false;
  private awaitingWinner = false;

  // Timers
  private winnerTimer: NodeJS.Timeout | null = null;

  constructor(private readonly room: BonkRoom, private readonly cfg: PickConfig) {
    const spec = GAMEMODE_MAP[cfg.gamemode] ?? GAMEMODE_MAP['classic']!;
    this.activeTeams = TEAMS_BY_COUNT[spec.teamCount];
    this.isFootball = cfg.gamemode === 'football';
    this.resetState();
    this.attach();
    // Sala já ativa quando o controller foi criado (eventos room-created/rebuilt
    // já dispararam antes do listener ser registrado via session.on('room-added'))
    if (room.state.myId !== null) this.setupRoom();
  }

  private get myId(): number | null {
    return this.room.state.myId;
  }

  // ─── Ciclo de vida da sala ───────────────────────────────────────────────────

  private resetState(): void {
    this.rosters = new Map(this.activeTeams.map(t => [t, []]));
    this.specQueue = [];
    this.gameActive = false;
    this.awaitingWinner = false;
    this.clearWinnerTimer();
  }

  private setupRoom(): void {
    // Ordem crítica: setTeamsEnabled ANTES de setTeam(bot, spec).
    // O servidor pode redistribuir times ao processar o setTeamsEnabled (packet 32),
    // sobrescrevendo qualquer atribuição prévia. Por isso o bot vai ao spec por ÚLTIMO,
    // garantindo que a instrução chega depois da redistribuição do servidor.
    this.room.setTeamsEnabled(true);
    this.room.setMode(this.cfg.engine, this.cfg.mode);
    this.room.setRounds(this.cfg.rounds);
    const mid = this.myId;
    if (mid !== null) this.room.setTeam(mid, TEAM_SPEC);
  }

  // ─── Listeners ──────────────────────────────────────────────────────────────

  private attach(): void {
    const r = this.room;

    r.on('room-created', () => this.setupRoom());
    r.on('room-join',    () => this.setupRoom());
    r.on('room-rebuilt', () => { this.resetState(); this.setupRoom(); });

    r.on('player-join', (pkt) => {
      if (pkt.id === this.myId) return;
      // Delay de 400ms: aguarda o servidor processar o join antes de mover o jogador.
      setTimeout(() => this.onPlayerJoin(pkt.id), 400);
    });

    r.on('player-leave', (pkt) => {
      if (pkt.id === this.myId) return;
      this.onPlayerLeave(pkt.id);
    });

    r.on('game-start', () => { this.gameActive = true; });
    r.on('game-end',   () => { this.gameActive = false; this.onGameEnd(); });

    r.on('chat-message', (pkt) => {
      if (pkt.id === this.myId) return;
      this.handleChat(pkt.message.trim());
    });

    // Guarda reativa do bot: se o servidor mover o bot para qualquer time que não seja
    // spec (ex: ao processar setTeamsEnabled), o revert é imediato via setTeam(bot, spec).
    // Não passa pela fila de mutações — é uma correção direta e de baixo custo.
    r.on('team-change', (pkt) => {
      const mid = this.myId;
      if (mid !== null && pkt.id === mid && pkt.team !== TEAM_SPEC) {
        this.room.setTeam(mid, TEAM_SPEC);
      }
    });
  }

  // ─── Eventos de jogador ──────────────────────────────────────────────────────

  private onPlayerJoin(id: number): void {
    // Jogador pode ter saído durante a janela de 400ms
    if (!this.room.state.players.has(id)) return;
    // Evento duplicado (já rastreado internamente)
    if (this.isTracked(id)) return;

    if (this.gameActive) {
      this.specQueue.push(id);
    } else {
      this.assignToSlot(id);
    }
    this.applyAssignments();
  }

  private onPlayerLeave(id: number): void {
    let freedTeam: number | null = null;
    for (const [team, roster] of this.rosters) {
      const idx = roster.indexOf(id);
      if (idx !== -1) {
        roster.splice(idx, 1);
        freedTeam = team;
        break;
      }
    }
    const specIdx = this.specQueue.indexOf(id);
    if (specIdx !== -1) this.specQueue.splice(specIdx, 1);

    if (!this.gameActive && freedTeam !== null) this.fillFromSpec(freedTeam);
    this.applyAssignments();
  }

  // ─── Alocação de slots ───────────────────────────────────────────────────────

  private assignToSlot(id: number): void {
    for (const team of this.activeTeams) {
      const roster = this.rosters.get(team)!;
      if (roster.length < this.cfg.maxTeamSize) {
        roster.push(id);
        return;
      }
    }
    this.specQueue.push(id);
  }

  private fillFromSpec(team: number): void {
    const roster = this.rosters.get(team)!;
    while (roster.length < this.cfg.maxTeamSize && this.specQueue.length > 0) {
      const next = this.specQueue.shift()!;
      if (this.room.state.players.has(next)) roster.push(next);
    }
  }

  // ─── Sincronização com o servidor ────────────────────────────────────────────

  /**
   * Envia todos os setTeam necessários para alinhar o servidor ao estado interno.
   * Só emite o packet se o time conhecido do servidor for diferente do desejado
   * (evita rate_limit_cot). Bot vai para spec sempre, sem verificação de estado
   * (o bot pode não constar no players Map após ROOM_CREATED).
   */
  private applyAssignments(): void {
    const mid = this.myId;
    const players = this.room.state.players;

    // Bot: incondicional — pode não estar no players Map após ROOM_CREATED
    if (mid !== null) this.room.setTeam(mid, TEAM_SPEC);

    for (const [team, roster] of this.rosters) {
      for (const id of roster) {
        const p = players.get(id);
        if (!p || p.team !== team) this.room.setTeam(id, team);
      }
    }
    for (const id of this.specQueue) {
      const p = players.get(id);
      if (!p || p.team !== TEAM_SPEC) this.room.setTeam(id, TEAM_SPEC);
    }
  }

  // ─── Fim de partida ──────────────────────────────────────────────────────────

  private onGameEnd(): void {
    if (!this.isFootball) {
      this.rotateChallengers();
      this.applyAssignments();
      return;
    }
    this.awaitingWinner = true;
    this.room.chat('Fim de jogo! Quem venceu? !win blue ou !win red');
    this.winnerTimer = setTimeout(() => {
      if (!this.awaitingWinner) return;
      this.resolveWinner(TEAM_BLUE);
    }, 20_000);
  }

  // Modos não-football: campeão (blue) permanece, todos os outros times vão ao spec
  private rotateChallengers(): void {
    for (const team of this.activeTeams.slice(1)) {
      const roster = this.rosters.get(team)!;
      this.specQueue.push(...roster);
      this.rosters.set(team, []);
      this.fillFromSpec(team);
    }
  }

  private resolveWinner(winnerTeam: number): void {
    this.clearWinnerTimer();
    this.awaitingWinner = false;
    this.applyFootballRotation(winnerTeam);
    this.applyAssignments();
  }

  /**
   * King-of-the-hill para football:
   * - Vencedores ficam no slot do campeão (blue)
   * - Perdedores vão para o final da fila de spec
   * - Próximo da fila preenche o slot do desafiador (red)
   */
  private applyFootballRotation(winnerTeam: number): void {
    const champ      = this.activeTeams[0]!; // TEAM_BLUE
    const challenger = this.activeTeams[1]!; // TEAM_RED

    const champRoster = [...this.rosters.get(champ)!];
    const challRoster = [...this.rosters.get(challenger)!];

    const winners = winnerTeam === champ ? champRoster : challRoster;
    const losers  = winnerTeam === champ ? challRoster : champRoster;

    this.rosters.set(champ, []);
    this.rosters.set(challenger, []);

    // Vencedores assumem o slot do campeão
    for (const id of winners.slice(0, this.cfg.maxTeamSize)) {
      this.rosters.get(champ)!.push(id);
    }
    // Perdedores vão para o final da fila
    this.specQueue.push(...losers);
    // Preenche o desafiador com o próximo da fila
    this.fillFromSpec(challenger);
  }

  // ─── Chat ────────────────────────────────────────────────────────────────────

  private handleChat(msg: string): void {
    const lower = msg.toLowerCase();
    if (lower === '!ping') { this.room.chat('Pong!'); return; }
    if (lower === '!start') {
      if (!this.gameActive && !this.awaitingWinner) this.room.startGame();
      return;
    }
    if (lower === '!stop') {
      if (this.gameActive) this.room.stopGame();
      return;
    }
    if (!this.awaitingWinner) return;
    if (lower === '!win blue') { this.resolveWinner(TEAM_BLUE); return; }
    if (lower === '!win red')  { this.resolveWinner(TEAM_RED);  return; }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private isTracked(id: number): boolean {
    for (const roster of this.rosters.values()) if (roster.includes(id)) return true;
    return this.specQueue.includes(id);
  }

  private clearWinnerTimer(): void {
    if (this.winnerTimer) { clearTimeout(this.winnerTimer); this.winnerTimer = null; }
  }

  destroy(): void {
    this.clearWinnerTimer();
  }
}
