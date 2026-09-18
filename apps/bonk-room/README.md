# bonk-room

Bot de referência construído sobre [`@bonktools/core`](../../packages/core): hospeda uma sala de football no bonk.io 24h, monta os times automaticamente (1v1, 2v2…) e mantém quem entra depois como espectador, com a partida em andamento visível.

Use como modelo para o seu próprio bot.

## Como rodar

```bash
cp .env.example .env                       # preencha BONK_USERNAME e BONK_PASSWORD
cp bonk-room.example.json bonk-room.json   # nome, modo, rounds da sala (arquivo ignorado pelo git)
pnpm dev
```

O link da sala aparece no log (`sala ativa`).

## Estrutura

| Arquivo | Papel |
|---|---|
| `src/index.ts` | Logger, config, `BonkSession` (pool de salas com reconexão) |
| `src/example-bot.ts` | `ExampleBot`: liga os eventos da sala (`room-created`, `player-join`, …) ao controlador |
| `src/pick/PickController.ts` | Regras de time/pick, início e fim de partida, fila de espectadores |
| `src/config.ts` | Schema (zod) do `bonk-room.json` e leitura de variáveis de ambiente |
| `src/capture-is.ts` | Utilitário para capturar o IS blob de uma partida real |

Variáveis de ambiente e opções: veja `.env.example`.

## Espectadores tardios

Com uma partida em andamento, o host deve enviar `INFORM_IN_GAME` **no lugar de** `INFORM_IN_LOBBY` para quem entra (o client só aceita um pacote de dados iniciais). A lib faz isso sozinha; detalhes em [`BONK_PROTOCOL.md`](../../BONK_PROTOCOL.md).

## Exemplos

- [`examples/antiAfk.ts`](examples/antiAfk.ts) — anti-AFK em ~10 linhas: `room.enableAntiAfk()` + eventos `player-afk` / `player-back`. A lógica vive na lib (`packages/core/src/room/AntiAfk.ts`).
