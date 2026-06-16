import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const defaultConnectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/model_card_portal';

function buildPgConfig(connectionString = defaultConnectionString) {
  const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
  const sslEnabled = ['require', 'verify-ca', 'verify-full', 'true', '1'].includes(sslMode);

  if (!sslEnabled) {
    return { connectionString };
  }

  return {
    connectionString,
    ssl: {
      rejectUnauthorized: ['verify-ca', 'verify-full'].includes(sslMode),
    },
  };
}

export const pool = new pg.Pool({
  ...buildPgConfig(defaultConnectionString),
});

async function ensureDatabaseExists() {
  const url = new URL(defaultConnectionString);
  const targetDb = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');

  if (!targetDb || targetDb === 'postgres') {
    return;
  }

  const adminUrl = new URL(defaultConnectionString);
  adminUrl.pathname = '/postgres';

  const adminClient = new pg.Client(buildPgConfig(adminUrl.toString()));

  try {
    await adminClient.connect();
    const { rows } = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (!rows.length) {
      const quotedDbName = `"${targetDb.replace(/"/g, '""')}"`;
      await adminClient.query(`CREATE DATABASE ${quotedDbName}`);
    }
  } finally {
    await adminClient.end().catch(() => {});
  }
}

export async function initDb() {
  await ensureDatabaseExists();
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_card_admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text UNIQUE NOT NULL,
      display_name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE model_card_admins
    ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT ''
  `);
  await pool.query(`
    UPDATE model_card_admins
    SET display_name = username
    WHERE display_name IS NULL OR display_name = ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_card_projects (
      id SERIAL PRIMARY KEY,
      name varchar(255) NOT NULL UNIQUE,
      start_date date,
      end_date date,
      intro text NOT NULL DEFAULT '',
      registration_deadline_at timestamptz,
      disk_dir text,
      created_by uuid REFERENCES model_card_admins(id) ON DELETE SET NULL,
      created_at timestamp DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS start_date date
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS end_date date
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS intro text DEFAULT ''
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS registration_deadline_at timestamptz
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS disk_dir text
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT CURRENT_TIMESTAMP
  `);
  await pool.query(`
    ALTER TABLE model_card_projects
    ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES model_card_admins(id) ON DELETE SET NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS model_card_projects_created_by_idx
    ON model_card_projects(created_by)
  `);
  await pool.query(`
    UPDATE model_card_projects
    SET created_by = (
      SELECT id
      FROM model_card_admins
      WHERE username = 'admin'
      ORDER BY created_at ASC
      LIMIT 1
    )
    WHERE created_by IS NULL
  `);
  await pool.query(`
    UPDATE model_card_projects
    SET disk_dir = '/home/node/.n8n-files/model-card/' || regexp_replace(name, '[\\\\/:*?"<>|]', '_', 'g') || '/'
    WHERE disk_dir IS NULL OR disk_dir = ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_card_roles (
      id SERIAL PRIMARY KEY,
      project_id integer NOT NULL REFERENCES model_card_projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, name)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_card_submissions (
      id SERIAL PRIMARY KEY,
      project_id integer REFERENCES model_card_projects(id) ON DELETE SET NULL,
      role_id integer REFERENCES model_card_roles(id) ON DELETE SET NULL,
      project_name text NOT NULL,
      role_name text NOT NULL,
      person_name text NOT NULL,
      phone text NOT NULL,
      wechat text NOT NULL DEFAULT '',
      intro_text text NOT NULL,
      status text NOT NULL DEFAULT 'processing',
      pptx_file_name text,
      pptx_disk_path text,
      pptx_url text,
      download_token text,
      pptx_base64 text,
      n8n_response jsonb,
      submitted_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    ALTER TABLE model_card_submissions
    ADD COLUMN IF NOT EXISTS download_token text
  `);
  await pool.query(`
    UPDATE model_card_submissions
    SET download_token = encode(gen_random_bytes(24), 'hex')
    WHERE download_token IS NULL OR download_token = ''
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS model_card_submissions_download_token_idx
    ON model_card_submissions(download_token)
  `);
  await pool.query(`
    UPDATE model_card_submissions
    SET pptx_url = '/api/submissions/download/' || download_token
    WHERE download_token IS NOT NULL
      AND download_token <> ''
      AND (pptx_url IS NULL OR pptx_url LIKE '%/api/submissions/%/download')
  `);
}

export async function ensureDefaultAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || '';
  const existing = await pool.query('SELECT 1 FROM model_card_admins WHERE username = $1', [username]);
  if (existing.rows[0]) return;
  if (password.length < 12 || password === 'admin123') {
    throw new Error('ADMIN_PASSWORD must be set to a strong value before creating the default admin account');
  }
  const hash = bcrypt.hashSync(password, 10);

  await pool.query(
    `INSERT INTO model_card_admins (username, display_name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING`,
    [username, username, hash]
  );
}

export async function backfillProjectCreators() {
  await pool.query(`
    UPDATE model_card_projects
    SET created_by = (
      SELECT id
      FROM model_card_admins
      WHERE username = 'admin'
      ORDER BY created_at ASC
      LIMIT 1
    )
    WHERE created_by IS NULL
  `);
}
