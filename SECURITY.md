# Segurança

## Nunca commite credenciais

Este repositório é público. Credenciais do bonk.io (`BONK_USERNAME` / `BONK_PASSWORD`) vivem **apenas** em arquivos `.env`, que o `.gitignore` já ignora. Versione somente os `.env.example` (sem valores).

Também estão fora do git (configuração/estado local):

- `apps/bonk-room/bonk-room.json` — sua config de sala (use `bonk-room.example.json` como base)
- `map-blob-cache.json`, `captured-blobs.json` — caches de IS blobs
- perfis de navegador (o `blob-seeder` usa um browser real: nunca versione a pasta de perfil, ela guarda cookies e sessões)

Se você commitou uma credencial por engano: **troque a senha imediatamente** (remover o arquivo em um commit novo não apaga o histórico) e só então reescreva o histórico.

## Reportar uma vulnerabilidade

Abra uma [issue privada de segurança](https://github.com/brenoluizdev/BonkTools-Core-repo/security/advisories/new) no GitHub em vez de uma issue pública.
