# Daymark Todo List

A small task manager app built with TypeScript, Node.js, PostgreSQL, and a browser UI. It includes user authentication, task CRUD operations, filtering, categories, and due dates.

## Source

This project is named `daymark-todolist`, as defined in `package.json`. The source code in this workspace is the local project source; no external repository URL is configured.

Main source files:

- `server.ts` — backend server, authentication, and PostgreSQL access
- `app.ts` — frontend TypeScript source
- `index.html` and `styles.css` — frontend structure and styling

## Features

- Sign up and sign in with email + password
- Create, edit, delete, complete, and filter tasks
- Task categories such as Personal and Work
- Due dates and priority levels
- PostgreSQL storage through the `pg` connection pool
- Browser-based task dashboard

## Project structure

- `server.ts` — HTTP server, auth, and PostgreSQL logic
- `app.ts` — frontend TypeScript app logic
- `app.js` — compiled browser JavaScript output
- `index.html` — app layout
- `styles.css` — styling
- PostgreSQL database — tables are created automatically at startup

## Dummy data examples

These are realistic example values for testing the app quickly.

### Example user

```json
{
  "id": 1,
  "name": "Alex Morgan",
  "email": "alex@example.com",
  "password": "password123"
}
```

### Example tasks

```json
[
  {
    "id": 1,
    "title": "Plan sprint goals",
    "notes": "Review priorities and update the roadmap for this week.",
    "category": "Work",
    "priority": "high",
    "dueDate": "2026-09-30T09:00",
    "completed": 0,
    "createdAt": "2026-09-29T08:15:00",
    "updatedAt": "2026-09-29T08:15:00"
  },
  {
    "id": 2,
    "title": "Buy groceries",
    "notes": "Milk, eggs, rice, oranges, and coffee.",
    "category": "Personal",
    "priority": "medium",
    "dueDate": "2026-10-01T18:30",
    "completed": 0,
    "createdAt": "2026-09-28T20:00:00",
    "updatedAt": "2026-09-28T20:00:00"
  },
  {
    "id": 3,
    "title": "Finish reading design notes",
    "notes": "Highlight the final UI recommendations and share them with the team.",
    "category": "Work",
    "priority": "low",
    "dueDate": null,
    "completed": 1,
    "createdAt": "2026-09-27T10:30:00",
    "updatedAt": "2026-09-29T07:50:00"
  }
]
```

## Run locally

From the `todolist` folder:

```bash
npm install
npm run build
npm start
```

Before starting the server, set `DATABASE_URL` to your PostgreSQL connection string. The default is:

```text
postgresql://postgres:postgres@localhost:5432/daymark
```

Example:

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/daymark"
```

Make sure the PostgreSQL server and the `daymark` database already exist. The app creates its tables and indexes automatically.

Then open:

```text
http://localhost:5173
```

## Login test account

You can create a new account in the app, or use a dummy account like:

- Email: `alex@example.com`
- Password: `password123`

## Notes

This is a small learning app, so the data is intentionally simple. PostgreSQL tables are created automatically when the server starts; existing SQLite data is not migrated automatically.
