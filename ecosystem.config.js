module.exports = {
  apps: [
    {
      name: 'espressoduty',
      script: 'node',
      args: '-r dotenv/config .next/standalone/server.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      kill_timeout: 8000,
    },
  ],
};
