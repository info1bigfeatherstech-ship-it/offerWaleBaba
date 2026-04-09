module.exports = {
  apps: [{
    name: 'ecommerce-api',
    script: './index.js',
    instances: 'max',
    exec_mode: 'cluster',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8081
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    kill_timeout: 30000,
    listen_timeout: 5000,
    shutdown_with_message: true
  }]
};