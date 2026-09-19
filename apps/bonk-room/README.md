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

## Times, capitães e escolha (football)

Tudo é calculado a partir de `BONK_MAXTEAMSIZE` (N). Regras do `PickController`:

- **Times sempre iguais.** Ao iniciar, cada time tem `min(N, ⌊jogadores disponíveis / times⌋)` jogadores; o excedente espera no spec. Nunca 2v1, 3v1 ou 3v4.
- **1º jogador → azul, 2º → vermelho** (são os capitães). Os seguintes esperam no spec.
- **Spec completa os times** → a partida pára e o capitão do time com menos jogadores escolhe **digitando o número** do jogador no chat (30 s; sem resposta, escolhe o 1º). O último candidato entra sozinho.
- **Fim de partida:** o time perdedor inteiro vai para o fim da fila do spec; o vencedor **sempre fica no azul**. O 1º da fila vira capitão do vermelho e escolhe os demais. O vencedor é informado por um jogador em campo com `!win blue` / `!win red` (sem resposta em 20 s, o azul segue).
- **Saída no meio da partida:** a partida pára; entra um substituto do spec (com escolha, se houver opção) ou os times são rebalanceados.
- **Troca de time por conta própria** (spec entrando num time, ou jogador saindo do seu) é revertida / tratada como saída.

### Comandos

| Comando | Quem | Efeito |
|---|---|---|
| `!afk` | qualquer um | alterna AFK: vai para o spec e não pode ser escolhido. **Em partida, quem está jogando não pode ficar AFK.** |
| `<n>` (só o número) | capitão da vez | escolhe o jogador nº *n* da lista (`!pick <n>` continua aceito) |
| `!win blue` / `!win red` | jogador em campo | informa o vencedor |
| `!start` / `!stop` | jogador em campo | inicia / pára (e segura o reinício até o próximo `!start`) |
| `!ping` | qualquer um | responde `Pong!` |

**AFK automático:** a lib (`enableAntiAfk`) detecta 12 s sem se mexer nem falar. Em partida o jogador só é avisado; ao **fim** da partida ele vai para o spec como AFK. Se nenhum frame de movimento chegou durante a partida (sinal indisponível), ninguém é punido.

### Testes

`pnpm --filter bonk-room test` — cenários do fluxo acima, AFK e um fuzz com centenas de sequências aleatórias que verifica, a cada partida iniciada, times iguais, ≤ N e sem AFK em campo.

## Espectadores tardios

Com uma partida em andamento, o host deve enviar `INFORM_IN_GAME` **no lugar de** `INFORM_IN_LOBBY` para quem entra (o client só aceita um pacote de dados iniciais). A lib faz isso sozinha; detalhes em [`BONK_PROTOCOL.md`](../../BONK_PROTOCOL.md).

## Exemplos

- [`examples/antiAfk.ts`](examples/antiAfk.ts) — anti-AFK em ~10 linhas: `room.enableAntiAfk()` + eventos `player-afk` / `player-back`. A lógica vive na lib (`packages/core/src/room/AntiAfk.ts`).
