import type { BonkRoom, MapBlobCache } from '@bonktools/core';
import { TEAM_SPEC, TEAM_FFA, TEAM_BLUE, TEAM_RED, TEAM_GREEN, TEAM_YELLOW } from '@bonktools/core';

export { TEAM_SPEC, TEAM_FFA, TEAM_BLUE, TEAM_RED, TEAM_GREEN, TEAM_YELLOW };

const TEAM_NAME: Record<number, string> = {
  [TEAM_SPEC]: 'spec', [TEAM_FFA]: 'ffa', [TEAM_RED]: 'red',
  [TEAM_BLUE]: 'blue', [TEAM_GREEN]: 'green', [TEAM_YELLOW]: 'yellow',
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

// O PRIMEIRO time é o do campeão/capitão fixo: quem ganha sempre fica nele (azul no football).
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
  /** Blob LZ-String fallback (legado / BONK_INITIAL_STATE). */
  initialState?: string;
  /**
   * Blobs por jogadores ativos (excluindo bot): { "1": solo, "2": 1v1, "4": 2v2 }.
   * ATENÇÃO: só são seguros se a sala estiver no MESMO mapa em que foram capturados
   * (o IS blob codifica spawn positions específicas do mapa). Usados como último
   * fallback, depois do cache por mapa — ver `mapBlobCache`.
   */
  initialStates?: Record<string, string>;
  /**
   * Cache local de IS blobs por (mapa, jogadores ativos) — ver `packages/core/src/cache/mapBlobCache.ts`.
   * Quando presente, é a fonte PREFERIDA de blob em `autoStart()`: correta para
   * qualquer mapa, ao contrário de `initialState`/`initialStates` que assumem um
   * mapa fixo. Populado pelo seeder (`apps/blob-seeder`) ou por captura manual.
   */
  mapBlobCache?: MapBlobCache;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Regras (sempre baseadas em `maxTeamSize` = N):
 *  - Times têm SEMPRE o mesmo tamanho ao iniciar (nada de 2v1/3v1): o tamanho `m` é
 *    min(N, ⌊jogadores disponíveis / times usados⌋); sobra vai pro spec.
 *  - 1º jogador → time azul (capitão), 2º → vermelho (capitão). Quando o spec completa
 *    os times, o jogo pára e o capitão do time com menos jogadores escolhe (`!pick n`);
 *    o último candidato é colocado automaticamente.
 *  - Fim de partida (football): perdedor inteiro → spec (fim da fila); vencedor sempre
 *    vira azul; o 1º da fila vira capitão do vermelho e escolhe os demais.
 *  - AFK (`!afk` ou inatividade detectada) → spec, nunca é escolhido nem entra na fila.
 *    Em partida, um jogador ativo não pode ficar AFK.
 */
export class PickController {
  private readonly room: BonkRoom;
  private readonly cfg: PickConfig;
  private readonly activeTeams: number[];
  private readonly isFootball: boolean;
  private readonly N: number;

  private static readonly PICK_TIMEOUT_MS = 30_000;
  private static readonly START_DELAY_MS = 500;
  private static readonly SEND_DELAY_MS = 300;
  private static readonly WINNER_TIMEOUT_MS = 20_000;
  private static readonly MOVE_ECHO_WINDOW_MS = 1_500;
  private static readonly VERIFY_INTERVAL_MS = 5_000;
  private static readonly RETRY_DELAY_MS = 1_000;

  private rosters = new Map<number, number[]>();
  private specQueue: number[] = []; // spec elegível (nunca contém AFK)
  private afk = new Set<number>(); // AFK (manual ou automático): em spec, fora da fila
  private pendingAfk = new Set<number>(); // inativos detectados em partida (viram AFK no fim dela)
  private inputSeen = false; // chegou algum frame de movimento nesta partida? (sinal confiável)
  private gameActive = false;
  private starting = false; // startGame enviado, aguardando game-start
  private holdStart = false; // `!stop` manual: não reinicia sozinho
  private awaitingWinner = false;
  private pickTeam: number | null = null;
  private lastAnnounce = '';
  private lastJoinTime = 0;
  private lastMove = new Map<number, { team: number; at: number }>();

  private winnerTimeout: Timer | null = null;
  private pickTimeout: Timer | null = null;
  private startTimer: Timer | null = null;
  private sendTimer: Timer | null = null;
  private startingGuard: Timer | null = null;
  private verifyTimer: ReturnType<typeof setInterval> | null = null;

  constructor(room: BonkRoom, cfg: PickConfig) {
    this.room = room;
    this.cfg = cfg;
    this.N = Math.max(1, cfg.maxTeamSize);
    const spec = GAMEMODE_MAP[cfg.gamemode] ?? GAMEMODE_MAP['classic']!;
    this.activeTeams = TEAMS_BY_COUNT[spec.teamCount];
    this.isFootball = cfg.gamemode === 'football';
    this.resetState();
    this.attach();
    this.verifyTimer = setInterval(() => this.verifyTeams(), PickController.VERIFY_INTERVAL_MS);
    this.verifyTimer.unref?.();
    // Sala já ativa quando o controller foi criado: room-created/rebuilt já
    // dispararam antes do listener ser registrado (via session.on('room-added')).
    if (room.state.myId !== null) this.onRoomReady();
  }

  // ─── Estado / utilidades ───────────────────────────────────────────────────

  private get running(): boolean {
    return this.gameActive || this.starting;
  }

  private clear(t: Timer | null): null {
    if (t) clearTimeout(t);
    return null;
  }

  private resetState(): void {
    this.rosters = new Map(this.activeTeams.map((t) => [t, []]));
    this.specQueue = [];
    this.afk.clear();
    this.pendingAfk.clear();
    this.lastMove.clear();
    this.gameActive = false;
    this.starting = false;
    this.holdStart = false;
    this.awaitingWinner = false;
    this.lastAnnounce = '';
    this.pickTeam = null;
    this.winnerTimeout = this.clear(this.winnerTimeout);
    this.pickTimeout = this.clear(this.pickTimeout);
    this.startTimer = this.clear(this.startTimer);
    this.sendTimer = this.clear(this.sendTimer);
    this.startingGuard = this.clear(this.startingGuard);
  }

  private log(msg: string): void {
    process.stdout.write(`[LOG] ${msg}\n`);
  }

  private name(id: number): string {
    return this.room.state.players.get(id)?.userName ?? `id=${id}`;
  }

  private isPresent(id: number): boolean {
    return id !== this.room.state.myId && this.room.state.players.has(id);
  }

  private roster(team: number): number[] {
    return this.rosters.get(team)!;
  }

  private size(team: number): number {
    return this.roster(team).length;
  }

  private rosterTeamOf(id: number): number | null {
    for (const [team, r] of this.rosters) if (r.includes(id)) return team;
    return null;
  }

  private activeCount(): number {
    return this.activeTeams.reduce((s, t) => s + this.size(t), 0);
  }

  private eligible(): number[] {
    return this.specQueue.filter((id) => this.isPresent(id) && !this.afk.has(id));
  }

  /** Time em que o jogador DEVERIA estar (undefined = desconhecido pelo controller). */
  private expectedTeam(id: number): number | undefined {
    const t = this.rosterTeamOf(id);
    if (t !== null) return t;
    if (this.specQueue.includes(id) || this.afk.has(id)) return TEAM_SPEC;
    return undefined;
  }

  /** Move jogador para um time e registra log de movimentação. */
  private movePlayer(id: number, team: number): void {
    this.log(`[MOVE] ${this.name(id)} > ${TEAM_NAME[team] ?? String(team)}`);
    this.lastMove.set(id, { team, at: Date.now() });
    this.room.setTeam(id, team);
  }

  /** Remove o jogador de qualquer lista do controller. */
  private forget(id: number): { wasActive: boolean } {
    const wasActive = this.rosterTeamOf(id) !== null;
    for (const r of this.rosters.values()) {
      const i = r.indexOf(id);
      if (i !== -1) r.splice(i, 1);
    }
    this.specQueue = this.specQueue.filter((x) => x !== id);
    this.afk.delete(id);
    this.pendingAfk.delete(id);
    this.lastMove.delete(id);
    return { wasActive };
  }

  /** Estado somente-leitura (testes / diagnóstico). */
  snapshot(): { rosters: Record<number, number[]>; specQueue: number[]; afk: number[]; pickTeam: number | null; running: boolean } {
    return {
      rosters: Object.fromEntries([...this.rosters].map(([t, r]) => [t, [...r]])),
      specQueue: [...this.specQueue],
      afk: [...this.afk],
      pickTeam: this.pickTeam,
      running: this.running,
    };
  }

  // ─── Sala ──────────────────────────────────────────────────────────────────

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
    r.enableAntiAfk(); // inatividade em partida → player-afk (ver onAutoAfk)
    // Só o host move jogadores: impede trocas de time por conta própria na origem (a reversão
    // em checkPlayerTeam fica como rede de segurança).
    r.lockTeams();
    this.enforceSpectator();
  }

  private attach(): void {
    const r = this.room;

    r.on('room-created', () => this.onRoomReady());
    r.on('room-join',    () => this.onRoomReady());
    r.on('room-rebuilt', () => { this.resetState(); this.onRoomReady(); });

    r.on('team-change', (pkt) => {
      const myId = r.state.myId;
      if (myId !== null && pkt.id === myId) {
        // Snap-back do bot: BLOQUEADO durante jogo ativo (joinTeam em partida pode abortá-la).
        if (this.gameActive || pkt.team === TEAM_SPEC) return;
        this.room.joinTeam(TEAM_SPEC);
        setTimeout(() => this.room.joinTeam(TEAM_SPEC), 300);
        return;
      }
      this.checkPlayerTeam(pkt.id, pkt.team);
    });

    r.on('player-join', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.lastJoinTime = Date.now();
      setTimeout(() => this.onPlayerJoin(pkt.id), 400);
    });

    r.on('player-leave', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.onPlayerLeave(pkt.id);
    });

    r.on('game-start', () => {
      this.gameActive = true;
      this.starting = false;
      this.startingGuard = this.clear(this.startingGuard);
      this.inputSeen = false;
      this.pendingAfk.clear();
    });

    r.on('game-end', () => {
      if (!this.gameActive) return;
      this.gameActive = false;
      // Detecta interrupção pelo servidor: novo jogador entrou há menos de 3s
      const interrupted = (Date.now() - this.lastJoinTime) < 3000;
      this.onGameEnd(interrupted);
    });

    r.on('peer-input', () => { this.inputSeen = true; });
    r.on('player-afk', (id) => this.onAutoAfk(id));
    r.on('player-back', (id) => { this.pendingAfk.delete(id); });

    r.on('chat-message', (pkt) => {
      if (pkt.id === r.state.myId) return;
      this.handleChat(pkt.message.trim(), pkt.id);
    });
  }

  // ─── Plano de times ────────────────────────────────────────────────────────

  /**
   * Quantos times usar e de que tamanho, dado o total de jogadores disponíveis
   * (em campo + fila elegível). Garante times iguais e nunca acima de N.
   */
  private plan(): { used: number; m: number } {
    const total = this.activeCount() + this.eligible().length;
    if (total === 0) return { used: 0, m: 0 };
    const used = Math.min(this.activeTeams.length, total);
    return { used, m: Math.min(this.N, Math.floor(total / used)) };
  }

  /** Forma da partida em curso: nº de times não-vazios e tamanho do menor. */
  private currentShape(): { used: number; m: number } {
    const sizes = this.activeTeams.map((t) => this.size(t)).filter((s) => s > 0);
    return { used: sizes.length, m: sizes.length ? Math.min(...sizes) : 0 };
  }

  private purge(): void {
    const seen = new Set<number>();
    for (const [team, r] of this.rosters) {
      this.rosters.set(team, r.filter((id) => {
        if (!this.isPresent(id) || this.afk.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      }));
    }
    this.specQueue = this.specQueue.filter((id) => {
      if (!this.isPresent(id) || this.afk.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    for (const id of [...this.afk]) if (!this.isPresent(id)) this.afk.delete(id);
    for (const id of [...this.pendingAfk]) if (!this.isPresent(id)) this.pendingAfk.delete(id);
  }

  /** Compacta os times para a esquerda: o vencedor/campeão sempre ocupa o primeiro (azul). */
  private normalize(): void {
    const nonEmpty = this.activeTeams.map((t) => this.roster(t)).filter((r) => r.length > 0).map((r) => [...r]);
    this.activeTeams.forEach((team, i) => {
      const next = nonEmpty[i] ?? [];
      const prev = this.roster(team);
      this.rosters.set(team, next);
      for (const id of next) if (!prev.includes(id)) this.movePlayer(id, team);
    });
  }

  /** Devolve ao INÍCIO da fila quem passa do tamanho `m` (ou está em time não usado). */
  private trim(used: number, m: number): void {
    const surplus: number[] = [];
    this.activeTeams.forEach((team, i) => {
      const r = this.roster(team);
      const keep = i < used ? m : 0;
      if (r.length > keep) surplus.push(...r.splice(keep));
    });
    if (surplus.length === 0) return;
    this.specQueue = [...surplus, ...this.specQueue];
    for (const id of surplus) this.movePlayer(id, TEAM_SPEC);
  }

  private seat(id: number, team: number): void {
    this.specQueue = this.specQueue.filter((x) => x !== id);
    this.roster(team).push(id);
    this.movePlayer(id, team);
  }

  /** Preenche capitães e vagas; abre escolha quando o capitão tem opção real. */
  private fill(used: number, m: number): 'picking' | 'done' {
    const teams = this.activeTeams.slice(0, used);
    for (;;) {
      const cand = this.eligible();
      if (cand.length === 0 || m === 0) return 'done';

      const empty = teams.find((t) => this.size(t) === 0);
      if (empty !== undefined) { this.seat(cand[0]!, empty); continue; }

      const needy = teams
        .filter((t) => this.size(t) < m)
        .sort((a, b) => this.size(a) - this.size(b) || teams.indexOf(a) - teams.indexOf(b));
      if (needy.length === 0) return 'done';

      const team = needy[0]!;
      const need = m - this.size(team);
      if (cand.length <= need) { for (const id of cand) this.seat(id, team); continue; }

      this.startPick(team);
      return 'picking';
    }
  }

  /** Reavalia tudo (fora de partida): times, capitães, escolha e início. */
  private applyPlan(): void {
    this.startTimer = this.clear(this.startTimer);
    this.sendTimer = this.clear(this.sendTimer);
    this.purge();
    // Votação do vencedor em andamento: reorganizar agora mudaria o significado de
    // !win blue/red. A rotação (resolveWinner) chama applyPlan de novo em seguida.
    if (this.awaitingWinner) { this.syncSpec(); return; }
    this.normalize();
    const { used, m } = this.plan();
    this.trim(used, m);
    if (this.fill(used, m) === 'picking') { this.syncSpec(); return; }
    this.cancelPick();
    this.syncSpec();
    this.scheduleStart();
  }

  /** Garante que fila e AFK estejam realmente no time spec do jogo. */
  private syncSpec(): void {
    for (const id of [...this.specQueue, ...this.afk]) {
      if (!this.isPresent(id)) continue;
      const lm = this.lastMove.get(id);
      const recent = lm && lm.team === TEAM_SPEC && Date.now() - lm.at < PickController.MOVE_ECHO_WINDOW_MS;
      if (this.room.state.players.get(id)?.team !== TEAM_SPEC && !recent) this.movePlayer(id, TEAM_SPEC);
    }
  }

  // ─── Início da partida ─────────────────────────────────────────────────────

  private scheduleStart(): void {
    if (this.running || this.pickTeam !== null || this.holdStart) return;
    if (this.activeCount() === 0) return;
    this.startTimer = this.clear(this.startTimer);
    this.startTimer = setTimeout(() => this.autoStart(), PickController.START_DELAY_MS);
  }

  /** Invariantes que TODA partida iniciada deve cumprir. Retorna o motivo da violação. */
  private violation(): string | null {
    const sizes = this.activeTeams.map((t) => this.size(t)).filter((s) => s > 0);
    if (sizes.length === 0) return 'sem jogadores';
    if (sizes.some((s) => s > this.N)) return `time acima de maxTeamSize=${this.N}`;
    if (new Set(sizes).size > 1) return `times desiguais (${sizes.join('v')})`;
    for (const r of this.rosters.values()) for (const id of r) {
      if (this.afk.has(id)) return `AFK em campo (${this.name(id)})`;
      if (!this.isPresent(id)) return `jogador ausente em campo (id=${id})`;
    }
    return null;
  }

  /**
   * Resolve o IS blob a usar para `totalPlayers` jogadores ativos.
   * Ordem de preferência:
   *   1. Cache por mapa (`mapBlobCache`) — correto para o mapa ATUAL da sala.
   *   2. `initialStates`/`initialState` legados — só válidos se a sala estiver
   *      no mesmo mapa em que foram capturados (não garantido para mapas
   *      aleatórios; ver aviso em `PickConfig.initialStates`).
   * Loga um aviso quando cai no fallback legado ou quando não há blob algum —
   * nesses casos o GAME_START pode chegar com `is` incorreto/vazio e o client
   * do jogador trava no lobby (RangeError na engine de física).
   */
  private resolveInitialState(totalPlayers: number): string | undefined {
    const cached = this.cfg.mapBlobCache?.getForMap(this.room.currentMap, totalPlayers);
    if (cached) return cached;

    const legacy = this.cfg.initialStates?.[String(totalPlayers)] ?? this.cfg.initialState;
    if (legacy) {
      process.stdout.write(
        `[WARN] sem blob no cache para este mapa (${totalPlayers} jogadores) — usando fallback legado, ` +
        'pode quebrar o client se o mapa atual for diferente do capturado\n',
      );
      return legacy;
    }

    process.stdout.write(
      `[WARN] nenhum IS blob disponível para ${totalPlayers} jogadores neste mapa — ` +
      'GAME_START sairá sem física válida. Rode o seeder (apps/blob-seeder) pra esse mapa.\n',
    );
    return undefined;
  }

  private autoStart(): void {
    this.startTimer = null;
    if (this.running || this.pickTeam !== null || this.holdStart) return;

    // Revalida na hora de iniciar (o estado pode ter mudado desde o agendamento).
    this.purge();
    this.normalize();
    const { used, m } = this.plan();
    this.trim(used, m);
    if (this.fill(used, m) === 'picking') return;

    const bad = this.violation();
    if (bad) {
      if (bad !== 'sem jogadores') this.log(`[WARN] início bloqueado: ${bad}`);
      return;
    }

    if (this.winnerTimeout) this.winnerTimeout = this.clear(this.winnerTimeout);
    this.awaitingWinner = false;
    // Re-aplica times do roster (servidor pode ter resetado após GAME_END)
    for (const [team, roster] of this.rosters) for (const id of roster) this.movePlayer(id, team);
    this.room.joinTeam(TEAM_SPEC);

    const myId = this.room.state.myId ?? 0;
    const bal: Record<number, number> = { [myId]: 0 };
    let bodyIdx = 1;
    for (const team of this.activeTeams) {
      for (const playerId of this.roster(team)) bal[playerId] = bodyIdx++;
    }

    // Chave = número de jogadores ativos (exclui bot): 1=solo, 2=1v1, 4=2v2
    const is = this.resolveInitialState(bodyIdx - 1);
    const opts = is ? { is, gs: { bal } } : undefined;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (this.running) return;
      // Última barreira: alguém pode ter trocado de time sozinho entre o agendamento e agora.
      // Iniciar assim daria 2v1/3v1 — corrige e tenta de novo.
      if (!this.teamsInSync()) {
        this.verifyTeams();
        if (!this.running) this.startTimer = setTimeout(() => this.autoStart(), PickController.RETRY_DELAY_MS);
        return;
      }
      this.starting = true;
      // Se o servidor nunca confirmar (game-start), não trava a sala em "iniciando".
      this.startingGuard = setTimeout(() => { this.starting = false; }, 4000);
      this.room.startGame(opts);
    }, PickController.SEND_DELAY_MS);
  }

  private stopGameState(): void {
    this.room.stopGame();
    this.gameActive = false;
    this.starting = false;
    this.startingGuard = this.clear(this.startingGuard);
    this.awaitingWinner = false;
    this.winnerTimeout = this.clear(this.winnerTimeout);
    this.startTimer = this.clear(this.startTimer);
    this.sendTimer = this.clear(this.sendTimer);
  }

  // ─── Entrada / saída de jogadores ──────────────────────────────────────────

  private onPlayerJoin(id: number): void {
    if (!this.isPresent(id)) return;
    if (this.expectedTeam(id) !== undefined) return; // evento duplicado
    this.specQueue.push(id);
    this.onQueueGain();
  }

  /** Novo elegível na fila (entrou ou saiu do AFK): reinicia só se isso permitir times maiores. */
  private onQueueGain(): void {
    if (this.running) {
      const p = this.plan();
      const cur = this.currentShape();
      if (p.used > cur.used || p.m > cur.m) {
        this.stopGameState();
        this.applyPlan();
      } else {
        // Espectador entra sem interromper a partida (INFORM_IN_GAME cuida da sincronia).
        this.syncSpec();
      }
      return;
    }
    this.applyPlan();
  }

  private onPlayerLeave(id: number): void {
    const { wasActive } = this.forget(id);
    if (wasActive) {
      // Saiu alguém em campo: parar evita continuar 2v1/3v1; o plano rebalanceia ou repõe.
      if (this.running) this.stopGameState();
      this.applyPlan();
      return;
    }
    if (this.pickTeam !== null) this.applyPlan(); // a lista de candidatos mudou
  }

  /** Jogador mudou de time por conta própria (ou eco atrasado de um comando nosso). */
  private checkPlayerTeam(id: number, actual: number): void {
    const exp = this.expectedTeam(id);
    if (exp === undefined || actual === exp) return;
    const lm = this.lastMove.get(id);
    if (lm && Date.now() - lm.at < PickController.MOVE_ECHO_WINDOW_MS) return; // eco do nosso comando

    if (exp === TEAM_SPEC) {
      this.log(`[GUARD] ${this.name(id)} tentou entrar em ${TEAM_NAME[actual] ?? actual} sozinho — revertido`);
      this.movePlayer(id, TEAM_SPEC);
      return;
    }
    // Jogador em campo saiu do time por conta própria: vira espectador na fila.
    this.log(`[GUARD] ${this.name(id)} saiu do time sozinho — removido do campo`);
    this.forget(id);
    this.specQueue.push(id);
    this.movePlayer(id, TEAM_SPEC);
    if (this.running) this.stopGameState();
    this.applyPlan();
  }

  /** Os times REAIS da sala (room.state) batem com os que o controller espera? */
  private teamsInSync(): boolean {
    for (const p of this.room.state.players.values()) {
      if (p.id === this.room.state.myId) continue;
      const exp = this.expectedTeam(p.id);
      if (exp === undefined) {
        if (this.activeTeams.includes(p.team)) return false; // desconhecido já dentro de um time
      } else if (p.team !== exp) return false;
    }
    return true;
  }

  private verifyTeams(): void {
    for (const p of this.room.state.players.values()) {
      if (p.id === this.room.state.myId) continue;
      this.checkPlayerTeam(p.id, p.team);
    }
  }

  // ─── AFK ───────────────────────────────────────────────────────────────────

  private markAfk(id: number): void {
    const { wasActive } = this.forget(id);
    this.afk.add(id);
    this.movePlayer(id, TEAM_SPEC);
    this.room.chat(`o jogador ${this.name(id)} agora está afk!`);
    if (wasActive || this.pickTeam !== null || !this.running) this.applyPlan();
  }

  private unmarkAfk(id: number): void {
    this.afk.delete(id);
    this.specQueue.push(id);
    this.room.chat(`o jogador ${this.name(id)} saiu do afk!`);
    this.onQueueGain();
  }

  private toggleAfk(id: number): void {
    if (!this.isPresent(id)) return;
    if (this.afk.has(id)) { this.unmarkAfk(id); return; }
    if (this.rosterTeamOf(id) !== null && this.running) {
      this.room.chat(`${this.name(id)}, você está em partida e não pode ficar afk!`);
      return;
    }
    if (this.expectedTeam(id) === undefined) return; // ainda não processado
    this.markAfk(id);
  }

  /** Inatividade detectada pela lib em partida: só vira AFK quando a partida acaba. */
  private onAutoAfk(id: number): void {
    if (this.rosterTeamOf(id) === null) return;
    this.pendingAfk.add(id);
    this.room.chat(`${this.name(id)} está inativo — irá para o afk ao fim da partida.`);
  }

  private applyAutoAfk(): void {
    // Sem nenhum frame de movimento na partida o sinal não é confiável (ex.: WebRTC
    // indisponível): nesse caso não punimos ninguém.
    const trust = this.inputSeen;
    const ids = [...this.pendingAfk];
    this.pendingAfk.clear();
    if (!trust) return;
    for (const id of ids) {
      if (this.rosterTeamOf(id) === null) continue;
      this.forget(id);
      this.afk.add(id);
      this.movePlayer(id, TEAM_SPEC);
      this.room.chat(`o jogador ${this.name(id)} agora está afk!`);
    }
  }

  // ─── Escolha (capitães) ────────────────────────────────────────────────────

  private startPick(team: number): void {
    if (this.pickTeam !== team) {
      this.pickTimeout = this.clear(this.pickTimeout);
      this.pickTeam = team;
      this.pickTimeout = setTimeout(() => {
        if (this.pickTeam !== null) this.executePick(0);
      }, PickController.PICK_TIMEOUT_MS);
    }
    this.announcePickList();
  }

  private cancelPick(): void {
    this.pickTimeout = this.clear(this.pickTimeout);
    this.pickTeam = null;
    this.lastAnnounce = '';
  }

  private announcePickList(): void {
    const team = this.pickTeam!;
    const cand = this.eligible();
    const key = `${team}|${this.roster(team)[0]}|${cand.join(',')}`;
    if (key === this.lastAnnounce) return;
    this.lastAnnounce = key;
    const captain = this.roster(team)[0];
    const captainName = captain !== undefined ? this.name(captain) : '?';
    const list = cand.map((id, i) => `${i + 1} - ${this.name(id)}`).join(', ');
    this.room.chat(`${captainName} (${TEAM_NAME[team]}), escolha: !pick <número>`);
    this.room.chat(`Disponíveis: ${list}`);
  }

  private executePick(index: number): void {
    const team = this.pickTeam;
    if (team === null) return;
    const id = this.eligible()[index];
    if (id === undefined) { this.applyPlan(); return; }
    this.cancelPick();
    this.seat(id, team);
    this.applyPlan();
  }

  // ─── Fim de partida / rotação ──────────────────────────────────────────────

  private onGameEnd(interrupted: boolean): void {
    this.applyAutoAfk();
    if (interrupted) {
      // Servidor interrompeu o jogo (novo jogador entrou) — reinicia sem rotação.
      // 600ms garante que o onPlayerJoin com delay de 400ms já executou antes do restart.
      setTimeout(() => { if (!this.running) this.applyPlan(); }, 600);
      return;
    }
    if (!this.isFootball) { this.rotateChallengers(); return; }

    const contested = this.activeTeams.filter((t) => this.size(t) > 0).length >= 2;
    if (!contested) { this.applyPlan(); return; } // solo/sem adversário: nada a decidir

    this.awaitingWinner = true;
    this.room.chat('Fim de jogo! Quem venceu? !win blue ou !win red');
    this.winnerTimeout = setTimeout(() => {
      if (!this.awaitingWinner) return;
      this.resolveWinner(this.activeTeams[0]!); // sem resposta: o time fixo (azul) segue
    }, PickController.WINNER_TIMEOUT_MS);
  }

  private resolveWinner(winner: number): void {
    this.winnerTimeout = this.clear(this.winnerTimeout);
    this.awaitingWinner = false;
    this.applyFootballRotation(winner);
  }

  /** Perdedor inteiro → spec (fim da fila); vencedor SEMPRE fica no primeiro time (azul). */
  private applyFootballRotation(winner: number): void {
    const [blue, red] = [this.activeTeams[0]!, this.activeTeams[1]!];
    const loser = winner === blue ? red : blue;
    const losers = [...this.roster(loser)];
    this.rosters.set(loser, []);
    for (const id of losers) {
      this.specQueue.push(id);
      this.movePlayer(id, TEAM_SPEC);
    }
    if (winner === red) {
      const winners = [...this.roster(red)];
      this.rosters.set(red, []);
      this.rosters.set(blue, winners);
      for (const id of winners) this.movePlayer(id, blue);
    }
    this.applyPlan(); // 1º da fila vira capitão do vermelho e escolhe os demais
  }

  private rotateChallengers(): void {
    for (const team of this.activeTeams.slice(1)) {
      const losers = [...this.roster(team)];
      this.rosters.set(team, []);
      for (const id of losers) {
        this.specQueue.push(id);
        this.movePlayer(id, TEAM_SPEC);
      }
    }
    this.applyPlan();
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  private handleChat(msg: string, senderId: number): void {
    const lower = msg.toLowerCase();
    if (lower === '!ping') { this.room.chat('Pong!'); return; }
    if (lower === '!afk')  { this.toggleAfk(senderId); return; }

    const active = this.rosterTeamOf(senderId) !== null;
    if (lower === '!start' || lower === '!stop') {
      if (!active) { this.room.chat(`${this.name(senderId)}, só jogadores em campo podem usar ${lower}.`); return; }
      if (lower === '!start') this.handleStartCommand(); else this.handleStopCommand();
      return;
    }

    if (this.pickTeam !== null) {
      const match = lower.match(/^!pick\s+(\d+)$/) ?? lower.match(/^(\d+)$/);
      if (match) {
        if (this.roster(this.pickTeam)[0] !== senderId) return; // só o capitão escolhe
        const idx = parseInt(match[1]!, 10) - 1;
        const total = this.eligible().length;
        if (idx >= 0 && idx < total) this.executePick(idx);
        else this.room.chat(`Número inválido. Escolha entre 1 e ${total}.`);
      }
      return;
    }

    if (!this.awaitingWinner || !active) return;
    if (lower === '!win blue') this.resolveWinner(TEAM_BLUE);
    else if (lower === '!win red') this.resolveWinner(TEAM_RED);
  }

  private handleStartCommand(): void {
    if (this.pickTeam !== null) { this.room.chat('Escolha em andamento.'); return; }
    if (this.running) { this.room.chat('Partida já em andamento.'); return; }
    this.holdStart = false;
    this.awaitingWinner = false; // pula a votação de vencedor
    this.winnerTimeout = this.clear(this.winnerTimeout);
    if (this.activeCount() === 0) { this.room.chat('Nenhum jogador em campo.'); return; }
    this.applyPlan();
  }

  private handleStopCommand(): void {
    if (!this.running && this.pickTeam === null) {
      this.room.chat('Nenhuma partida em andamento.');
      return;
    }
    this.holdStart = true;
    if (this.pickTeam !== null) this.cancelPick();
    if (this.running) this.stopGameState();
  }

  destroy(): void {
    this.winnerTimeout = this.clear(this.winnerTimeout);
    this.pickTimeout = this.clear(this.pickTimeout);
    this.startTimer = this.clear(this.startTimer);
    this.sendTimer = this.clear(this.sendTimer);
    this.startingGuard = this.clear(this.startingGuard);
    if (this.verifyTimer) { clearInterval(this.verifyTimer); this.verifyTimer = null; }
  }
}
