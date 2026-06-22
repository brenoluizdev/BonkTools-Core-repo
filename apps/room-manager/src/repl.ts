// repl.ts — REPL readline de operação: comandos de gerenciamento do pool de salas.
// Nenhum comando de configuração de sala via chat — tudo via .env + rooms.json.

import readline from 'node:readline';
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
      if (session.rooms.size === 0) {
        process.stdout.write('Nenhuma sala ativa.\n');
        return;
      }
      for (const [id, entry] of session.rooms) {
        const link = entry.room.shareLink ?? '(sem link)';
        process.stdout.write(`${id}  ${entry.status}  ${entry.config.name}  ${link}\n`);
      }
    },
  ],
  [
    'chat',
    async (args, session) => {
      const entry = session.rooms.get(args[0] ?? '');
      if (!entry) { process.stdout.write('chat: sala não encontrada\n'); return; }
      const msg = args.slice(1).join(' ');
      if (!msg) { process.stdout.write('chat: mensagem obrigatória\n'); return; }
      entry.room.chat(msg);
    },
  ],
  [
    'kick',
    async (args, session) => {
      const entry = session.rooms.get(args[0] ?? '');
      if (!entry) { process.stdout.write('kick: sala não encontrada\n'); return; }
      const name = args.slice(1).join(' ').toLowerCase();
      for (const [, p] of entry.room.state.players) {
        if (p.userName.toLowerCase() === name) {
          entry.room.kickPlayer(p.id);
          process.stdout.write(`kick: "${p.userName}" kickado\n`);
          return;
        }
      }
      process.stdout.write('kick: jogador não encontrado\n');
    },
  ],
  [
    'players',
    async (args, session) => {
      const entry = session.rooms.get(args[0] ?? '');
      if (!entry) { process.stdout.write('players: sala não encontrada\n'); return; }
      for (const [, p] of entry.room.state.players) {
        process.stdout.write(`  id=${p.id} team=${p.team} "${p.userName}"\n`);
      }
    },
  ],
  [
    'help',
    async () => {
      process.stdout.write(
        'Comandos: list | chat <id> <msg> | kick <id> <nome> | players <id> | help | exit\n',
      );
    },
  ],
  [
    'exit',
    async (_args, _session, rl) => {
      rl.close();
    },
  ],
]);

/**
 * Liga o REPL a uma sessão: cada linha é parseada em cmd + args e despachada via COMMANDS.
 * CR-04: usa .catch() para capturar rejeições de promise sem lançar unhandledRejection.
 */
export function startRepl(session: BonkSession, rl: readline.Interface): void {
  rl.on('line', (input) => {
    const parts = input.trim().split(/\s+/);
    const cmd = parts[0] ?? '';
    const args = parts.slice(1);
    const handler = COMMANDS.get(cmd);
    if (!handler) {
      if (cmd) process.stdout.write(`Comando desconhecido: ${cmd}. Digite 'help'.\n`);
      return;
    }
    handler(args, session, rl).catch((err: unknown) => {
      process.stdout.write(
        `Erro ao executar '${cmd}': ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  });
}
