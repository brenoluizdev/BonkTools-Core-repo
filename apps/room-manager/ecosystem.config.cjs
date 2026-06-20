// ASVS V14: credenciais NÃO hardcoded aqui. BONK_USERNAME/PASSWORD vêm do shell env ou .env no deploy host.
module.exports = {
  apps: [
    {
      name: 'room-manager',
      script: 'dist/index.js',
      args: 'start --config rooms.json',
      env: { NODE_ENV: 'production' },
      kill_timeout: 10000,
      watch: false,
      max_memory_restart: '400M',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
    },
  ],
};
