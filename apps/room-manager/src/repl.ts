// repl.ts — REPL readline com dispatch table de 7 comandos (RM-03 / D-06).
// T-5-04-04: handlers validam args antes de chamar session; erros imprimem mensagem
// sem lançar exceção não capturada que derrubaria o processo.

import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { BonkSession } from '@bonktools/core';

type CommandHandler = (
  args: string[],
  session: BonkSession,
  rl: readline.Interface,
) => Promise<void>;

const COMMANDS = new Map<string, CommandHandler>([
  [
    'list',
    async (_args, session) => {
      for (const [id, entry] of session.rooms) {
        process.stdout.write(`${id}  ${entry.status}\n`);
      }
    },
  ],
  [
    'create',
    async (args, session) => {
      if (!args[0]) {
        process.stdout.write('create: nome obrigatório\n');
        return;
      }
      await session.addRoom({
        id: randomUUID(),
        name: args[0],
        password: '',
        maxPlayers: 6,
        mode: 'b',
        rounds: 3,
      });
    },
  ],
  [
    'remove',
    async (args, session) => {
      if (!args[0]) {
        process.stdout.write('remove: id obrigatório\n');
        return;
      }
      await session.removeRoom(args[0]);
    },
  ],
  [
    'chat',
    async (args, session) => {
      const entry = session.rooms.get(args[0] ?? '');
      if (!entry) {
        process.stdout.write('chat: sala não encontrada\n');
        return;
      }
      entry.room.chat(args.slice(1).join(' '));
    },
  ],
  [
    'kick',
    async (args, session) => {
      const entry = session.rooms.get(args[0] ?? '');
      if (!entry) {
        process.stdout.write('kick: sala não encontrada\n');
        return;
      }
      const name = args.slice(1).join(' ').toLowerCase();
      let found = false;
      for (const [, p] of entry.room.state.players) {
        if (p.userName.toLowerCase() === name) {
          entry.room.kickPlayer(p.id);
          found = true;
          break;
        }
      }
      if (!found) {
        process.stdout.write('kick: jogador não encontrado\n');
      }
    },
  ],
  [
    'help',
    async () => {
      process.stdout.write(
        'Comandos: list | create <nome> | remove <id> | chat <id> <msg> | kick <id> <nome> | help | exit\n',
      );
    },
  ],
  [
    'exit',
    async (_args, _session, rl) => {
      // O shutdown é instalado no index.ts via rl.on('close', ...) (WR-01).
      rl.close();
    },
  ],
]);

/**
 * Liga o REPL a uma sessão: cada linha é parseada em cmd + args e despachada via COMMANDS.
 * Comando desconhecido imprime mensagem sem lançar (T-5-04-04).
 *
 * CR-04: usa .catch() em vez de await direto no callback de evento para garantir que
 * rejeições de promise dos handlers não propaguem como unhandledRejection (fatal no Node v15+).
 */
export function startRepl(session: BonkSession, rl: readline.Interface): void {
  rl.on('line', (input) => {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);
    const handler = COMMANDS.get(cmd);
    if (!handler) {
      if (cmd) {
        process.stdout.write(`Comando desconhecido: ${cmd}. Digite 'help'.\n`);
      }
      return;
    }
    handler(args, session, rl).catch((err: unknown) => {
      process.stdout.write(
        `Erro ao executar '${cmd}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  });
}
