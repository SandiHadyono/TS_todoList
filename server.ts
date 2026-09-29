import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const appDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = join(appDirectory, 'data');
mkdirSync(dataDirectory, { recursive: true });

const database = new DatabaseSync(join(dataDirectory, 'daymark.sqlite'));
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
    notes TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Personal',
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const taskColumnsInfo = database.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
if (!taskColumnsInfo.some((column) => column.name === 'user_id')) {
  database.exec('ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id)');
}
database.exec('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)');
database.exec('CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id, completed, due_date)');
database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());

const taskColumns = `
  id, title, notes, category, priority, due_date AS dueDate,
  completed, created_at AS createdAt, updated_at AS updatedAt
`;
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const vendorFiles: Record<string, string> = {
  '/vendor/jquery.min.js': join(appDirectory, 'node_modules/jquery/dist/jquery.min.js'),
  '/vendor/select2.min.js': join(appDirectory, 'node_modules/select2/dist/js/select2.min.js'),
  '/vendor/select2.min.css': join(appDirectory, 'node_modules/select2/dist/css/select2.min.css'),
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new Error('Request is too large.');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isValidDueDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText ?? 0);
  const minute = Number(minuteText ?? 0);
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute;
}

function normalizeDueDate(value: string): string {
  return value.length === 10 ? `${value}T00:00:00` : value;
}

interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
}

function findSessionToken(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie ?? '';
  const sessionCookie = cookieHeader.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith('hcm_session='));
  return sessionCookie?.slice('hcm_session='.length) || null;
}

function findUserForRequest(request: IncomingMessage): AuthenticatedUser | null {
  const token = findSessionToken(request);
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = database.prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, new Date().toISOString()) as AuthenticatedUser | undefined;
  return row ?? null;
}

function sessionCookie(token: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hcm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function createSession(userId: number, response: ServerResponse): void {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  response.setHeader('set-cookie', sessionCookie(token, 14 * 24 * 60 * 60));
}

async function handleAuthApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/auth/')) return false;

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = findUserForRequest(request);
    sendJson(response, 200, user);
    return true;
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = findSessionToken(request);
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(createHash('sha256').update(token).digest('hex'));
    response.setHeader('set-cookie', sessionCookie('', 0));
    response.writeHead(204);
    response.end();
    return true;
  }

  if ((pathname === '/api/auth/login' || pathname === '/api/auth/register') && request.method === 'POST') {
    const body = await readJson(request);
    const email = cleanText(body.email, 254).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
      sendJson(response, 400, { error: 'Enter a valid email and a password of 10 to 128 characters.' });
      return true;
    }

    if (pathname.endsWith('/register')) {
      const name = cleanText(body.name, 80);
      if (!name) {
        sendJson(response, 400, { error: 'Enter your name to create an account.' });
        return true;
      }
      const salt = randomBytes(16).toString('hex');
      const passwordHash = scryptSync(password, salt, 64).toString('hex');
      try {
        database.exec('BEGIN IMMEDIATE');
        const result = database.prepare('INSERT INTO users (name, email, password_salt, password_hash) VALUES (?, ?, ?, ?)').run(name, email, salt, passwordHash);
        const userId = Number(result.lastInsertRowid);
        database.prepare('UPDATE tasks SET user_id = ? WHERE user_id IS NULL').run(userId);
        database.exec('COMMIT');
        createSession(userId, response);
        sendJson(response, 201, { id: userId, name, email });
      } catch (error) {
        database.exec('ROLLBACK');
        const isDuplicate = error instanceof Error && error.message.includes('UNIQUE constraint failed');
        sendJson(response, isDuplicate ? 409 : 500, { error: isDuplicate ? 'An account with that email already exists.' : 'Could not create your account.' });
      }
      return true;
    }

    const userRow = database.prepare('SELECT id, name, email, password_salt, password_hash FROM users WHERE email = ?').get(email) as (AuthenticatedUser & { password_salt: string; password_hash: string }) | undefined;
    if (!userRow) {
      scryptSync(password, 'hcm-invalid-login-salt', 64);
      sendJson(response, 401, { error: 'Email or password is incorrect.' });
      return true;
    }
    const candidateHash = scryptSync(password, userRow.password_salt, 64);
    const storedHash = Buffer.from(userRow.password_hash, 'hex');
    if (candidateHash.length !== storedHash.length || !timingSafeEqual(candidateHash, storedHash)) {
      sendJson(response, 401, { error: 'Email or password is incorrect.' });
      return true;
    }
    createSession(userRow.id, response);
    sendJson(response, 200, { id: userRow.id, name: userRow.name, email: userRow.email });
    return true;
  }

  sendJson(response, 404, { error: 'Not found.' });
  return true;
}

async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (await handleAuthApi(request, response, pathname)) return;

  const taskPath = pathname.match(/^\/api\/tasks(?:\/(\d+))?$/);
  if (!taskPath) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  const user = findUserForRequest(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sign in to continue.' });
    return;
  }

  const taskId = taskPath[1] ? Number(taskPath[1]) : null;
  if (request.method === 'GET' && taskId === null) {
    const tasks = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE user_id = ? ORDER BY completed ASC, created_at DESC, id DESC`).all(user.id);
    sendJson(response, 200, tasks);
    return;
  }

  if (request.method === 'POST' && taskId === null) {
    const body = await readJson(request);
      const title = cleanText(body.title, 160);
      if (!title) return sendJson(response, 400, { error: 'A task name is required.' });
      const notes = cleanText(body.notes, 1000);
      const category = cleanText(body.category, 40) || 'Personal';
      const priority = body.priority === 'high' || body.priority === 'low' ? body.priority : 'medium';
      if (body.dueDate !== null && body.dueDate !== undefined && body.dueDate !== '' && !isValidDueDate(body.dueDate)) return sendJson(response, 400, { error: 'Invalid due date and time.' });
      const dueDate = body.dueDate ? normalizeDueDate(body.dueDate as string) : null;
      const result = database.prepare('INSERT INTO tasks (user_id, title, notes, category, priority, due_date) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, title, notes, category, priority, dueDate);
      const task = database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ? AND user_id = ?`).get(Number(result.lastInsertRowid), user.id);
      sendJson(response, 201, task);
    return;
  }

  if (request.method === 'PATCH' && taskId !== null) {
    const body = await readJson(request);
      const fields: string[] = [];
      const values: (string | number | null)[] = [];
      if ('title' in body) {
        const title = cleanText(body.title, 160);
        if (!title) return sendJson(response, 400, { error: 'A task name is required.' });
        fields.push('title = ?');
        values.push(title);
      }
      if ('notes' in body) { fields.push('notes = ?'); values.push(cleanText(body.notes, 1000)); }
      if ('category' in body) { fields.push('category = ?'); values.push(cleanText(body.category, 40) || 'Personal'); }
      if ('priority' in body) {
        if (!['low', 'medium', 'high'].includes(String(body.priority))) return sendJson(response, 400, { error: 'Invalid priority.' });
        fields.push('priority = ?');
        values.push(String(body.priority));
      }
      if ('dueDate' in body) {
        const dueDate = body.dueDate;
        if (dueDate !== null && !isValidDueDate(dueDate)) return sendJson(response, 400, { error: 'Invalid due date and time.' });
        fields.push('due_date = ?');
        values.push(dueDate === null ? null : normalizeDueDate(dueDate as string));
      }
      if ('completed' in body) {
        if (typeof body.completed !== 'boolean') return sendJson(response, 400, { error: 'Invalid completion state.' });
        fields.push('completed = ?');
        values.push(body.completed ? 1 : 0);
      }
      if (fields.length === 0) return sendJson(response, 400, { error: 'No task changes provided.' });
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(taskId);
      values.push(user.id);
      const result = database.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
      if (result.changes === 0) return sendJson(response, 404, { error: 'Task not found.' });
      sendJson(response, 200, database.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ? AND user_id = ?`).get(taskId, user.id));
    return;
  }

  if (request.method === 'DELETE' && taskId !== null) {
    const result = database.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, user.id);
    if (result.changes === 0) return sendJson(response, 404, { error: 'Task not found.' });
    response.writeHead(204);
    response.end();
    return;
  }

  sendJson(response, 405, { error: 'Method not allowed.' });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    void handleApi(request, response, url.pathname).catch((error: unknown) => {
      if (response.headersSent) return response.destroy();
      sendJson(response, 400, { error: error instanceof Error ? error.message : 'Invalid request.' });
    });
    return;
  }

  if (url.pathname in vendorFiles) {
    try {
      const content = readFileSync(vendorFiles[url.pathname]);
      const extension = extname(url.pathname);
      response.writeHead(200, { 'content-type': mimeTypes[extension] ?? 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Install dependencies with npm install, then refresh this page.');
    }
    return;
  }

  const fileName = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'styles.css', 'app.js'].includes(fileName)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const content = readFileSync(join(appDirectory, fileName));
    response.writeHead(200, { 'content-type': mimeTypes[extname(fileName)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Build the app with npm run build, then refresh this page.');
  }
});

const port = Number(process.env.PORT ?? 5173);
server.listen(port, '127.0.0.1', () => {
  console.log(`HCM is ready at http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}