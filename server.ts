import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';

const appDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
const database = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/daymark',
});

async function initializeDatabase(): Promise<void> {
  await database.query(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
    notes TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Personal',
    priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
    due_date TIMESTAMPTZ,
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS tasks_user_idx ON tasks(user_id, completed, due_date);
`);
  await database.query('DELETE FROM sessions WHERE expires_at <= $1', [new Date()]);
}

const taskColumns = `
  id, title, notes, category, priority, due_date AS "dueDate",
  completed, created_at AS "createdAt", updated_at AS "updatedAt"
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

// sendJson writes a JSON response to the HTTP client.
// It is a reusable helper so every API route can respond in the same format.
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

// readJson collects the body of an incoming request, parses it as JSON, and validates it.
// The return type is a record object, which makes TypeScript safer when you use the data later.
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

// cleanText removes extra whitespace and limits text length.
// This keeps user input safe and consistent before it is saved to the database.
function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// isValidDueDate checks whether a string matches a valid YYYY-MM-DD or YYYY-MM-DDTHH:mm format.
// The return type is a type guard, which means TypeScript treats the value as a string after this check.
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

// normalizeDueDate makes a date-only value easier to compare and store consistently.
// If the input is just a date, it adds a time so the app can work with one common format.
function normalizeDueDate(value: string): string {
  return value.length === 10 ? `${value}T00:00:00` : value;
}

interface AuthenticatedUser {
  id: number;
  name: string;
  email: string;
}

// findSessionToken reads the browser cookie and extracts the session token.
// This is how the server identifies who is logged in on each request.
function findSessionToken(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie ?? '';
  const sessionCookie = cookieHeader.split(';').map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith('hcm_session='));
  return sessionCookie?.slice('hcm_session='.length) || null;
}

// findUserForRequest looks up the active user for a request using the session token.
// If no token exists or it has expired, the function returns null.
async function findUserForRequest(request: IncomingMessage): Promise<AuthenticatedUser | null> {
  const token = findSessionToken(request);
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const result = await database.query<AuthenticatedUser>(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1 AND sessions.expires_at > $2
  `, [tokenHash, new Date()]);
  return result.rows[0] ?? null;
}

// sessionCookie builds a secure cookie string for the authenticated user.
// It is a simple helper function because the same cookie format is used across login and logout.
function sessionCookie(token: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `hcm_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

// createSession creates a random session token, stores its hash, and sends the cookie to the browser.
// This pattern is common in web apps when you want to keep a user logged in without storing plain text secrets.
async function createSession(userId: number, response: ServerResponse): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await database.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
  response.setHeader('set-cookie', sessionCookie(token, 14 * 24 * 60 * 60));
}

// handleAuthApi handles login, registration, logout, and session lookup routes.
// It returns true when it handled the route so the main API handler does not continue processing it.
async function handleAuthApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/auth/')) return false;

  if (pathname === '/api/auth/me' && request.method === 'GET') {
    const user = await findUserForRequest(request);
    sendJson(response, 200, user);
    return true;
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = findSessionToken(request);
    if (token) await database.query('DELETE FROM sessions WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')]);
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
        const result = await database.query<{ id: number }>('INSERT INTO users (name, email, password_salt, password_hash) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, salt, passwordHash]);
        const userId = result.rows[0].id;
        await createSession(userId, response);
        sendJson(response, 201, { id: userId, name, email });
      } catch (error) {
        const isDuplicate = error instanceof Error && 'code' in error && error.code === '23505';
        sendJson(response, isDuplicate ? 409 : 500, { error: isDuplicate ? 'An account with that email already exists.' : 'Could not create your account.' });
      }
      return true;
    }

    const userResult = await database.query<AuthenticatedUser & { password_salt: string; password_hash: string }>('SELECT id, name, email, password_salt, password_hash FROM users WHERE email = $1', [email]);
    const userRow = userResult.rows[0];
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
    await createSession(userRow.id, response);
    sendJson(response, 200, { id: userRow.id, name: userRow.name, email: userRow.email });
    return true;
  }

  sendJson(response, 404, { error: 'Not found.' });
  return true;
}

// handleApi is the main task API router.
// It enforces auth, validates the route, and performs CRUD operations on tasks.
async function handleApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (await handleAuthApi(request, response, pathname)) return;

  const taskPath = pathname.match(/^\/api\/tasks(?:\/(\d+))?$/);
  if (!taskPath) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  const user = await findUserForRequest(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sign in to continue.' });
    return;
  }

  const taskId = taskPath[1] ? Number(taskPath[1]) : null;
  if (request.method === 'GET' && taskId === null) {
    const result = await database.query(`SELECT ${taskColumns} FROM tasks WHERE user_id = $1 ORDER BY completed ASC, created_at DESC, id DESC`, [user.id]);
    sendJson(response, 200, result.rows);
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
      const result = await database.query<{ id: number }>('INSERT INTO tasks (user_id, title, notes, category, priority, due_date) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [user.id, title, notes, category, priority, dueDate]);
      const task = await database.query(`SELECT ${taskColumns} FROM tasks WHERE id = $1 AND user_id = $2`, [result.rows[0].id, user.id]);
      sendJson(response, 201, task.rows[0]);
    return;
  }

  if (request.method === 'PATCH' && taskId !== null) {
    const body = await readJson(request);
      const fields: string[] = [];
      const values: (string | number | null | boolean)[] = [];
      if ('title' in body) {
        const title = cleanText(body.title, 160);
        if (!title) return sendJson(response, 400, { error: 'A task name is required.' });
        fields.push(`title = $${values.length + 1}`);
        values.push(title);
      }
      if ('notes' in body) { fields.push(`notes = $${values.length + 1}`); values.push(cleanText(body.notes, 1000)); }
      if ('category' in body) { fields.push(`category = $${values.length + 1}`); values.push(cleanText(body.category, 40) || 'Personal'); }
      if ('priority' in body) {
        if (!['low', 'medium', 'high'].includes(String(body.priority))) return sendJson(response, 400, { error: 'Invalid priority.' });
        fields.push(`priority = $${values.length + 1}`);
        values.push(String(body.priority));
      }
      if ('dueDate' in body) {
        const dueDate = body.dueDate;
        if (dueDate !== null && !isValidDueDate(dueDate)) return sendJson(response, 400, { error: 'Invalid due date and time.' });
        fields.push(`due_date = $${values.length + 1}`);
        values.push(dueDate === null ? null : normalizeDueDate(dueDate as string));
      }
      if ('completed' in body) {
        if (typeof body.completed !== 'boolean') return sendJson(response, 400, { error: 'Invalid completion state.' });
        fields.push(`completed = $${values.length + 1}`);
        values.push(body.completed ? 1 : 0);
      }
      if (fields.length === 0) return sendJson(response, 400, { error: 'No task changes provided.' });
      fields.push('updated_at = CURRENT_TIMESTAMP');
      const taskParameter = values.length + 1;
      const userParameter = values.length + 2;
      values.push(taskId);
      values.push(user.id);
      const result = await database.query(`UPDATE tasks SET ${fields.join(', ')} WHERE id = $${taskParameter} AND user_id = $${userParameter}`, values);
      if (result.rowCount === 0) return sendJson(response, 404, { error: 'Task not found.' });
      const task = await database.query(`SELECT ${taskColumns} FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, user.id]);
      sendJson(response, 200, task.rows[0]);
    return;
  }

  if (request.method === 'DELETE' && taskId !== null) {
    const result = await database.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [taskId, user.id]);
    if (result.rowCount === 0) return sendJson(response, 404, { error: 'Task not found.' });
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
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void database.end().finally(() => process.exit(0));
    });
  });
}

void initializeDatabase()
  .then(() => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`HCM is ready at http://localhost:${port}`);
    });
  })
  .catch((error: unknown) => {
    console.error('Could not initialize PostgreSQL:', error);
    void database.end().finally(() => process.exit(1));
  });