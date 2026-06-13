const siteUrl = process.env.SITE_URL || 'https://yh.ccyinghe.com';

const commonEnv = {
  NODE_ENV: 'production',
  SITE_URL: siteUrl,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || siteUrl,
};

module.exports = {
  apps: [
    {
      name: 'model-card-portal-3050',
      script: process.env.LEGACY_3050_SCRIPT || 'app.js',
      cwd: process.env.LEGACY_3050_CWD || undefined,
      instances: 1,
      autorestart: true,
      env: {
        ...commonEnv,
        PORT: 3050,
      },
    },
    {
      name: 'model-card-portal-3051',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      env: {
        ...commonEnv,
        PORT: 3051,
      },
    },
  ],
};
