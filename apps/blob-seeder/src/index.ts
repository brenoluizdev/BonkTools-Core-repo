/**
 * blob-seeder — captura IS blobs reais por mapa usando um browser real (Puppeteer)
 * logado com uma conta REGISTRADA como host da sala.
 *
 * Por que existe: o IS blob (estado inicial da física) é calculado pelo client
 * que efetivamente INICIA a partida (TRIGGER_START) — e só um client com engine
 * de física de verdade (o client oficial do bonk.io) sabe calculá-lo. O bot leve
 * do monorepo (`apps/bonk-room`, Socket.IO puro, sem browser) nunca consegue
 * gerar um blob novo — só REUSAR um que já foi calculado antes. Além disso, o
 * blob é específico do MAPA ativo na sala (posições de spawn variam por mapa),
 * então um blob capturado num mapa não é seguro pra reuso em outro.
 *
 * Este script roda uma vez, ao vivo, para um gamemode + conjunto de contagens
 * de jogadores, e grava o resultado no `MapBlobCache` local (mesmo arquivo que
 * `apps/bonk-room` consulta via BONK_BLOB_CACHE_PATH). Depois de rodado uma vez
 * para um mapa, o bot leve nunca mais precisa de browser para esse mapa —
 * só quando bonk.io atribuir um mapa novo/nunca visto à sala.
 *
 * O Puppeteer aqui só dirige a UI do host (login, criar sala, trocar modo,
 * clicar Start) — os jogadores que preenchem os times são conexões leves via
 * `@bonktools/core` (guest, sem browser), e a captura do blob em si também é
 * uma conexão leve (espectador), igual ao `capture-is.ts` do bonk-room.
 *
 * Uso:
 *   pnpm --filter blob-seeder seed <gamemode> [contagens separadas por vírgula]
 *   pnpm --filter blob-seeder seed vtol 1,2,4
 *
 * Requer BONK_USERNAME/BONK_PASSWORD de uma conta registrada real (.env).
 *
 * FRAGILIDADE CONHECIDA: a automação depende dos IDs de elementos DOM do
 * client bonk.io (`#newbonklobby_startbutton` etc). Se o bonk.io atualizar o
 * client e renomear esses IDs, este script para de funcionar até os seletores
 * abaixo (`SELECTORS`) serem atualizados — não há fallback automático.
 */

import puppeteer, { type Browser, type Frame, type Page } from 'puppeteer';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import {
  joinRoom,
  MapBlobCache,
  hashMap,
  TEAM_RED,
  TEAM_BLUE,
  TEAM_GREEN,
  TEAM_YELLOW,
  type BonkRoom,
} from '@bonktools/core';

const log = pino({ level: 'info', transport: { target: 'pino-pretty', options: { colorize: true } } });

/** IDs DOM estáveis do client bonk.io (dentro do iframe #maingameframe). */
const SELECTORS = {
  accountButton: 'guestOrAccountContainer_accountButton',
  loginUsername: 'loginwindow_username',
  loginPassword: 'loginwindow_password',
  loginSubmit: 'loginwindow_submitbutton',
  customGame: 'classic_mid_customgame',
  createOpen: 'roomlistcreatebutton',
  createMaxPlayers: 'roomlistcreatewindowmaxplayers',
  createConfirm: 'roomlistcreatecreatebutton',
  modeButton: 'newbonklobby_modebutton',
  teamsButton: 'newbonklobby_teamsbutton',
  startButton: 'newbonklobby_startbutton',
  linkButton: 'newbonklobby_linkbutton',
} as const;

/** Botão do dropdown de modo, por gamemode (mesmas chaves de GAMEMODE_MAP do bonk-room). */
const MODE_BUTTON_ID: Record<string, string> = {
  classic: 'newbonklobby_mode_classic',
  arrows: 'newbonklobby_mode_arrow',
  'death arrows': 'newbonklobby_mode_deatharrows',
  grapple: 'newbonklobby_mode_grapple',
  vtol: 'newbonklobby_mode_vtol',
  football: 'newbonklobby_mode_football',
};

/** Times ativos por gamemode (football usa só 2; os demais usam 4). */
const TEAM_COLORS_BY_MODE: Record<string, number[]> = {
  football: [TEAM_RED, TEAM_BLUE],
  classic: [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
  arrows: [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
  'death arrows': [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
  grapple: [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
  vtol: [TEAM_RED, TEAM_BLUE, TEAM_GREEN, TEAM_YELLOW],
};

function authFromEnv(): { username: string; password: string } {
  const username = process.env.BONK_USERNAME;
  const password = process.env.BONK_PASSWORD;
  if (!username) throw new Error('BONK_USERNAME must be set (see .env.example)');
  if (!password) throw new Error('BONK_PASSWORD must be set (see .env.example)');
  return { username, password };
}

function cachePathFromEnv(): string {
  return process.env.BONK_BLOB_CACHE_PATH
    ?? fileURLToPath(new URL('../map-blob-cache.json', import.meta.url));
}

/**
 * Localiza o iframe #maingameframe pelo elemento (não por frame.name(), que
 * reflete o atributo HTML `name` — o bonk.io só garante `id`). `.contentFrame()`
 * é a forma robusta do Puppeteer de obter o Frame a partir do elemento real.
 */
async function getGameFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('#maingameframe', { timeout: 20_000 });
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('#maingameframe não encontrado — bonk.io mudou de layout?');
  return frame;
}

/**
 * Clica num elemento #id dentro do #maingameframe usando um clique de MOUSE
 * REAL nas coordenadas absolutas da página (page.mouse.click), não uma API de
 * "clicabilidade" do Puppeteer. Duas abordagens mais simples já se mostraram
 * insuficientes ao vivo, ambas nesse mesmo client:
 *   1. `el.click()` via JS — não dispara os handlers de alguns botões (toggle
 *      de times, compartilhar link): sem erro, mas sem efeito nenhum.
 *   2. `ElementHandle.click()` do Puppeteer — lança "Node is either not
 *      clickable or not an Element": o client usa `position: absolute` numa
 *      hierarquia que confunde o cálculo de clickablePoint() do Puppeteer
 *      (mesma família do bug de offsetParent/visible:true).
 * Coordenada final = offset do iframe na página + offset do elemento dentro
 * do iframe (via getBoundingClientRect, que reflete o layout real mesmo
 * quando as heurísticas de "visível" acima erram).
 */
async function clickId(page: Page, id: string): Promise<void> {
  const frame = await getGameFrame(page);
  await frame.waitForSelector(`#${id}`, { timeout: 15_000 });

  const frameHandle = await page.$('#maingameframe');
  const frameBox = await frameHandle?.boundingBox();
  const elBox = await frame.evaluate((elId) => {
    const el = document.getElementById(elId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, id);
  if (!frameBox || !elBox) throw new Error(`não consegui calcular a posição de #${id} pra clicar`);

  await page.mouse.click(frameBox.x + elBox.x + elBox.width / 2, frameBox.y + elBox.y + elBox.height / 2);
}

async function typeInto(page: Page, id: string, text: string): Promise<void> {
  const frame = await getGameFrame(page);
  await frame.waitForSelector(`#${id}`, { timeout: 15_000 });
  await frame.evaluate((elId, value) => {
    const el = document.getElementById(elId) as HTMLInputElement | null;
    if (!el) throw new Error(`input #${elId} sumiu do DOM antes de digitar`);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, id, text);
}

/** Oculta iframes de anúncio que causam desalinhamento de layout/cliques. */
async function hideAds(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const hide = (): void => {
      document.querySelectorAll('iframe').forEach((f) => {
        if (f.id?.startsWith('google_ads_iframe')) (f as HTMLElement).style.display = 'none';
      });
    };
    hide();
    setInterval(hide, 1000);
  });
}

async function loginAsHost(page: Page, username: string, password: string): Promise<void> {
  await clickId(page, SELECTORS.accountButton);
  await typeInto(page, SELECTORS.loginUsername, username);
  await typeInto(page, SELECTORS.loginPassword, password);
  await clickId(page, SELECTORS.loginSubmit);
  const frame = await getGameFrame(page);
  await frame.waitForSelector(`#${SELECTORS.customGame}`, { timeout: 20_000 });
  log.info('logado como host (conta registrada)');
}

async function createRoomViaUI(page: Page, gamemode: string, maxPlayers: number): Promise<void> {
  const modeId = MODE_BUTTON_ID[gamemode];
  if (!modeId) {
    throw new Error(`gamemode inválido: "${gamemode}". Válidos: ${Object.keys(MODE_BUTTON_ID).join(', ')}`);
  }

  await clickId(page, SELECTORS.customGame);
  await clickId(page, SELECTORS.createOpen);
  await typeInto(page, SELECTORS.createMaxPlayers, String(maxPlayers));
  await clickId(page, SELECTORS.createConfirm);
  const frame = await getGameFrame(page);
  await frame.waitForSelector(`#${SELECTORS.startButton}`, { timeout: 20_000 });
  log.info({ gamemode, maxPlayers }, 'sala criada');

  await page.screenshot({ path: 'debug-1-before-mode.png' });
  await clickId(page, SELECTORS.modeButton);
  await new Promise((r) => setTimeout(r, 300)); // tempo do dropdown abrir
  await page.screenshot({ path: 'debug-2-mode-dropdown-open.png' });
  await clickId(page, modeId);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: 'debug-3-after-mode-select.png' });
  await clickId(page, SELECTORS.teamsButton);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: 'debug-4-after-teams-click.png' });
  log.info({ gamemode }, 'modo definido, times habilitados');
}

/**
 * Clica no botão de compartilhar link e lê a URL do texto visível na página
 * (o bonk.io mostra "Your clipboard has been set to: https://bonk.io/XXXXXX"
 * no chat da sala). NUNCA usa navigator.clipboard: o clipboard é do sistema
 * operacional inteiro, compartilhado com qualquer outra coisa que o usuário
 * copiou (já vazou uma senha de um .env por causa disso) — ler daí é inseguro
 * e não confiável. Ler o texto renderizado na própria página evita isso.
 */
async function getShareUrl(page: Page): Promise<string> {
  await page.screenshot({ path: 'debug-5-before-share-click.png' });
  await clickId(page, SELECTORS.linkButton);
  await new Promise((r) => setTimeout(r, 1000));
  await page.screenshot({ path: 'debug-6-after-share-click.png' });
  // textContent (não innerText): innerText respeita layout/visibilidade, e
  // elementos deste client às vezes reportam estado de visibilidade incorreto
  // (mesmo problema do offsetParent documentado em clickId).
  const frame = await getGameFrame(page);
  const text = await frame.evaluate(() => document.body.textContent ?? '');
  const match = /https:\/\/bonk\.io\/\d{6}[a-zA-Z0-9]{0,5}/.exec(text);
  if (!match) {
    log.warn({ textSnippet: text.slice(0, 500) }, 'texto da página não continha URL — snippet pra debug');
    throw new Error('não encontrei uma URL de sala bonk.io no texto da página após clicar em compartilhar');
  }
  return match[0];
}

interface CaptureResult {
  is: string;
  map: string | null;
}

/** Aguarda o próximo GAME_START no espectador e extrai `is` + `gs.map`. */
function waitForGameStart(spectator: BonkRoom, timeoutMs = 30_000): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperando GAME_START')), timeoutMs);
    spectator.once('game-start', (pkt) => {
      clearTimeout(timer);
      const gs = pkt.gs as Record<string, unknown> | undefined;
      resolve({
        is: typeof pkt.is === 'string' ? pkt.is : '',
        map: typeof gs?.['map'] === 'string' ? (gs['map'] as string) : null,
      });
    });
  });
}

async function seed(gamemode: string, counts: number[]): Promise<void> {
  const { username, password } = authFromEnv();
  const cache = new MapBlobCache(cachePathFromEnv());
  const teamColors = TEAM_COLORS_BY_MODE[gamemode]!;
  const maxPlayers = Math.max(8, Math.max(...counts));

  const headless = process.env.BLOB_SEEDER_HEADLESS !== 'false';
  let browser: Browser | undefined;

  try {
    browser = await puppeteer.launch({ headless });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await hideAds(page);
    // networkidle2 nunca resolve no bonk.io (ads/analytics mantêm tráfego constante) —
    // domcontentloaded é suficiente, já que os passos seguintes esperam seletores
    // específicos (waitForSelector), não o estado geral da página.
    await page.goto('https://bonk.io', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 2000)); // tempo pro maingameframe montar

    await loginAsHost(page, username, password);
    await createRoomViaUI(page, gamemode, maxPlayers);

    const roomUrl = await getShareUrl(page);
    log.info({ roomUrl }, 'link da sala obtido');

    const guests: BonkRoom[] = [];
    const spectator = await joinRoom(roomUrl, {
      auth: { type: 'guest', guestName: `Seeder${Math.floor(Math.random() * 10000)}` },
      role: 'spectator',
      logger: log,
    });

    const sortedCounts = [...counts].sort((a, b) => a - b);

    for (const count of sortedCounts) {
      while (guests.length < count) {
        const idx = guests.length;
        const guest = await joinRoom(roomUrl, {
          auth: { type: 'guest', guestName: `Seed${idx}_${Math.floor(Math.random() * 10000)}` },
          logger: log,
        });
        guest.joinTeam(teamColors[idx % teamColors.length]!);
        guests.push(guest);
      }

      log.info({ gamemode, count }, 'jogadores prontos — iniciando partida');
      const capturePromise = waitForGameStart(spectator);
      await clickId(page, SELECTORS.startButton);

      try {
        const { is, map } = await capturePromise;
        if (!is) {
          log.warn({ gamemode, count }, 'GAME_START chegou com is vazio — pulando esta contagem');
          continue;
        }
        const mapId = hashMap(map);
        cache.set(mapId, count, is);
        log.info({ gamemode, count, mapId, isLen: is.length }, '✅ blob capturado e salvo no cache');
      } catch (err) {
        log.error({ gamemode, count, err: (err as Error).message }, '❌ falha capturando esta contagem');
      }

      // Solta o botão de novo pra permitir reiniciar quando o próximo grupo de
      // jogadores entrar (mesmo padrão observado manualmente: clicar Start de
      // novo após novos jogadores entrarem reinicia a partida no mesmo mapa).
      await new Promise((r) => setTimeout(r, 500));
    }

    for (const g of guests) g.disconnect();
    spectator.disconnect();
    log.info({ gamemode, mapsInCache: cache.mapCount }, 'seeding concluído');
  } finally {
    await browser?.close();
  }
}

const [, , gamemodeArg, countsArg] = process.argv;
if (!gamemodeArg) {
  console.error('Uso: pnpm --filter blob-seeder seed <gamemode> [contagens separadas por vírgula]');
  console.error('Exemplo: pnpm --filter blob-seeder seed vtol 1,2,4');
  process.exit(1);
}

const counts = (countsArg ?? '1,2,4').split(',').map((s) => parseInt(s.trim(), 10));
if (counts.some((n) => isNaN(n) || n < 1)) {
  console.error('Contagens inválidas — use inteiros positivos separados por vírgula, ex: 1,2,4');
  process.exit(1);
}

await seed(gamemodeArg.toLowerCase(), counts);
process.exit(0);
