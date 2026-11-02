// Configuración de pm2. El login lo hace Authelia delante de nginx; aquí no hay secretos.
module.exports = {
  apps: [
    {
      name: 'repartos',
      script: './server.js',
      cwd: __dirname,
      node_args: '--no-warnings',
      // Un solo proceso en modo fork, como el resto de apps del servidor (pm2 7 usa cluster si no se indica).
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        PORT: '3016',
        HOST: '127.0.0.1',
        BASE_PATH: '/',
        APP_USERS: 'xavi,judit',
        DB_PATH: '/var/lib/repartos/repartos.db',
      },
    },
  ],
};
