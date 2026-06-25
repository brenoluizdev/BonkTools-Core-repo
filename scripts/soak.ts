// Soak test (RM-04): BONK_SOAK=1 gated. Mede RSS slope ao longo de 24h para detectar leaks.
// NUNCA loga credentials — usa authFromEnv() que já protege (ASVS V7).
//
// Imports pesados (@bonktools/core via room-manager) são dinâmicos APÓS o gate para que
// `tsx scripts/soak.ts` saia limpo sem precisar resolver o workspace package quando gateado.

if (!process.env.BONK_SOAK) {
  process.stderr.write('Soak test gateado: defina BONK_SOAK=1 para executar.\n');
  process.exit(0);
}

async function main(): Promise<void> {
  const { BonkSession } = await import('@bonktools/core');
  const { loadConfig, authFromEnv } = await import('../apps/room-manager/src/config.js');

  const roomCount = Number.parseInt(process.env.SOAK_ROOMS ?? '5', 10);
  const durationSec = Number.parseInt(process.env.SOAK_DURATION_SEC ?? '86400', 10);
  const configPath = process.env.SOAK_CONFIG ?? './apps/room-manager/rooms.example.json';

  const config = loadConfig(configPath);
  const auth = authFromEnv();
  // delayMs = 0 → Infinity para evitar 1/0 no throttle
  const delayMs = config.throttle.roomCreationDelayMs;
  const session = new BonkSession({
    auth,
    throttle: {
      capacity: config.throttle.maxConcurrentRooms,
      refillPerSec: delayMs > 0 ? 1 / (delayMs / 1000) : Infinity,
    },
  });

  await session.getToken(auth);

  // Cria N salas a partir do nome base do config (replica até atingir roomCount).
  const base = config.rooms[0]!;
  for (let i = 0; i < roomCount; i++) {
    await session.addRoom({ ...base, id: `soak-${i}`, name: `${base.name} #${i}` });
  }

  // CSV header — amostra process.memoryUsage() a cada 60s.
  process.stdout.write('timestamp,rss,heapUsed,roomCount\n');
  const sample = (): void => {
    const m = process.memoryUsage();
    process.stdout.write(`${new Date().toISOString()},${m.rss},${m.heapUsed},${session.rooms.size}\n`);
  };
  sample();
  const interval = setInterval(sample, 60_000);
  interval.unref?.();

  await new Promise<void>((resolve) => setTimeout(resolve, durationSec * 1000));

  clearInterval(interval);
  await session.destroy();
  process.exit(0);
}

void main();
