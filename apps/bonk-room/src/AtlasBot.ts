import type { BonkRoom } from '@bonktools/core';
import type { Logger } from 'pino';
import { PickController } from './pick/PickController.js';
import type { PickConfig } from './pick/PickController.js';

export class AtlasBot {
  private readonly pick: PickController;
  private readonly log: Logger;

  constructor(room: BonkRoom, logger: Logger, pickCfg: PickConfig) {
    this.log = logger.child({ component: 'AtlasBot' });
    this.pick = new PickController(room, pickCfg);
    this.attach(room);
  }

  private attach(room: BonkRoom): void {
    const { log } = this;

    room.on('room-created', () => {
      log.info('sala criada — bot é host');
      room.setNoHostSwap(true);
    });

    room.on('share-link', (pkt) => {
      log.info({ link: `https://bonk.io/${pkt.roomId}${pkt.bypass}` }, 'link da sala');
    });

    room.on('player-join', (pkt) => {
      log.info({ userName: pkt.userName, id: pkt.id }, 'jogador entrou');
    });

    room.on('player-leave', (pkt) => {
      log.info({ id: pkt.id }, 'jogador saiu');
    });

    room.on('team-change', (pkt) => {
      const name = room.state.players.get(pkt.id)?.userName ?? `id=${pkt.id}`;
      log.info({ id: pkt.id, name, team: pkt.team }, 'TEAM_CHANGE');
    });

    room.on('game-start', (pkt) => {
      const gs = pkt.gs as Record<string, unknown> | undefined;
      log.info({
        isLen: typeof pkt.is === 'string' ? pkt.is.length : 0,
        tea: gs?.['tea'],
        ga: gs?.['ga'],
        mo: gs?.['mo'],
        players: [...room.state.players.entries()].map(([id, p]) => ({ id, team: p.team, name: p.userName })),
      }, 'GAME_START');
    });
    room.on('game-end',           () => log.info('partida encerrada'));
    room.on('countdown',          (pkt) => log.info({ n: pkt.n }, '[COUNTDOWN] tick'));
    room.on('abort-countdown',    ()    => log.warn('[ABORT_COUNTDOWN] servidor abortou o countdown'));

    room.on('status-message', (pkt) => log.warn({ status: pkt.status }, 'status do servidor'));

    room.on('room-dead', (reason) => log.warn({ reason }, 'sala morreu'));

    room.on('room-rebuilt', (shareLink) => {
      log.info({ shareLink }, 'sala reconectada');
      room.setNoHostSwap(true);
    });
  }

  destroy(): void {
    this.pick.destroy();
  }
}
