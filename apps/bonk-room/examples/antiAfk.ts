import type { BonkRoom } from '@bonktools/core';

// Anti-AFK: 12 s sem se mexer nem falar no chat = AFK. A lógica está na lib;
// aqui só ligamos e reagimos aos eventos.
export function setupAntiAfk(room: BonkRoom): void {
  room.enableAntiAfk(); // opcional: { thresholdMs: 12_000 }

  const name = (id: number): string => room.state.players.get(id)?.userName ?? `#${id}`;

  room.on('player-afk', (id) => {
    room.chat(`${name(id)} está AFK!`);
    room.kickPlayer(id); // remova esta linha se só quiser avisar
  });

  room.on('player-back', (id) => room.chat(`${name(id)} voltou.`));
}

// Consulta pontual em qualquer lugar do projeto: room.isAfk(playerId)
