require('dotenv').config();

/** @type { import("drizzle-kit").Config } */
module.exports = {
  schema: './db/schema/*.js',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'agent_admin',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'agents_platform_db',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
  },
  verbose: true,
  strict: true,
};
