import { EventEmitter } from 'node:events';
import type { BonkRoom } from '@bonktools/core';

export const RED = 2;
export const BLUE = 3;

interface FakePlayer { id: number; userName: string; team: number }

/** Sala falsa que imita o servidor: eco de team-change, game-start/end assíncronos. */
export class FakeRoom extends EventEmitter {
  state = { myId: 0 as number | null, players: new Map<number, FakePlayer>() };
  chats: string[] = [];
  starts: Array<{ teams: Record<number, number[]>; total: number }> = [];
  stops = 0;
  gameRunning = false;
  botTeam = 0;

  constructor() {
    super();
    this.state.players.set(0, { id: 0, userName: 'BOT', team: 0 });
  }

  asRoom(): BonkRoom { return this as unknown as BonkRoom; }

  // API usada pelo PickController ------------------------------------------------
  setTeamsEnabled(): void {}
  setMode(): void {}
  setRounds(): void {}
  setReady(): void {}
  enableAntiAfk(): void {}
  locked = false;
  lockTeams(): void { this.locked = true; }
  unlockTeams(): void { this.locked = false; }
  joinTeam(team: number): void { this.botTeam = team; }
  chat(msg: string): void { this.chats.push(msg); }
  get currentMap(): string | null { return null; }

  setTeam(id: number, team: number): void {
    const p = this.state.players.get(id);
    if (!p) return;
    p.team = team;
    this.emit('team-change', { type: 'TEAM_CHANGE', id, team });
  }

  startGame(): void {
    this.starts.push(this.teamSnapshot());
    setTimeout(() => { this.gameRunning = true; this.emit('game-start', {}); }, 50);
  }

  stopGame(): void {
    this.stops++;
    if (!this.gameRunning) return;
    this.gameRunning = false;
    setTimeout(() => this.emit('game-end', {}), 50);
  }

  // Ações de "jogadores" ---------------------------------------------------------
  join(id: number, name = `P${id}`): void {
    this.state.players.set(id, { id, userName: name, team: 1 });
    this.emit('player-join', { type: 'PLAYER_JOIN', id, userName: name, team: 1 });
  }

  leave(id: number): void {
    this.state.players.delete(id);
    this.emit('player-leave', { type: 'PLAYER_LEAVE', id });
  }

  say(id: number, message: string): void {
    this.emit('chat-message', { type: 'CHAT_MESSAGE', id, message });
  }

  /** Jogador clica num time por conta própria (sem passar pelo bot). */
  selfMove(id: number, team: number): void {
    const p = this.state.players.get(id);
    if (!p) return;
    p.team = team;
    this.emit('team-change', { type: 'TEAM_CHANGE', id, team });
  }

  /** Fim natural de partida (servidor emite game-end). */
  endGame(): void {
    if (!this.gameRunning) return;
    this.gameRunning = false;
    this.emit('game-end', {});
  }

  // Consultas --------------------------------------------------------------------
  teamSnapshot(): { teams: Record<number, number[]>; total: number } {
    const teams: Record<number, number[]> = { [BLUE]: [], [RED]: [] };
    for (const p of this.state.players.values()) {
      if (p.id === 0) continue;
      if (p.team === BLUE || p.team === RED) teams[p.team]!.push(p.id);
    }
    return { teams, total: teams[BLUE]!.length + teams[RED]!.length };
  }

  teamOf(id: number): number | undefined { return this.state.players.get(id)?.team; }
  lastChats(n = 4): string[] { return this.chats.slice(-n); }
}
