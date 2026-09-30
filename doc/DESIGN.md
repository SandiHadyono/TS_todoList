# HCM Tasks Design Document

## 1. Design Direction

HCM Tasks is a quiet, editorially restrained task workspace. The visual language uses warm off-white surfaces, deep green actions, soft gray borders, and a small coral accent. Typography pairs DM Sans for interface text, Manrope for headings, and DM Mono for metadata and labels.

The design prioritizes scanning and quick action over decoration. The interface is a working task list, not a marketing landing page.

## 2. Information Architecture

### Signed-out experience

- Centered authentication panel.
- HCM brand mark and name.
- Sign-in and account-registration modes in one form.
- Name is shown only during registration.
- Inline error feedback appears near the submit action.

### Signed-in experience

- Sidebar navigation: All tasks, Today, Upcoming, Completed.
- List navigation for the fixed Personal and Work lists.
- Daily focus and account/sign-out section.
- Main workspace: breadcrumbs, search, summary statistics, task table, empty state, and add-task actions.
- Task dialog for create/edit actions.

## 3. Layouts

### Desktop

- Persistent sidebar on the left.
- Main workspace fills the remaining width, with a constrained content region.
- The task table uses columns for Task, Priority, Created at, Due date, and row actions.
- Task creation and editing happen in a centered dialog up to 480px wide and 680px tall.

### Mobile

- Compact top header with HCM branding and hamburger control.
- Sidebar becomes a slide-in drawer with backdrop and close action.
- Selecting a navigation view closes the drawer.
- The Created timestamp moves below each task's title; the wide Created at column is hidden.
- The main task controls and summary metrics adapt to narrow widths.

## 4. Task Dialog

- Dialog uses a fixed-height shell bounded by viewport height.
- The header remains visible.
- Fields live in an independently scrollable, centered content region (maximum width 400px).
- Scrollbar gutter is reserved on both sides to keep visual left/right spacing balanced.
- A sticky action footer remains at the bottom of the dialog while the fields scroll.
- Closing is supported by the X control, Cancel, clicking the backdrop, and native Escape behavior.
- List uses a native select with Personal and Work.
- Priority uses Select2 4.0.13 with local jQuery 3.7.1, custom color dots, and a dialog-parent dropdown.
- Due date uses the browser's native `date` input. The server stores date-only values as `YYYY-MM-DDT00:00:00`.

## 5. Task Table and Sorting

### Row content

- Completion checkbox.
- Task title and optional notes.
- Priority indicator with distinct color treatment.
- Created timestamp.
- Due date with calendar marker and overdue styling.
- Edit action.

### Sorting behavior

The toolbar's native sort selector offers:

- Priority: High, Medium, Low.
- Due date: earliest date first; tasks without a date last.
- Created at: newest first.

Incomplete tasks are grouped before completed tasks in all sort modes. Stable tie-breaking uses creation time and task ID.

## 6. Responsive Interaction Details

- Hamburger button exposes `aria-expanded` and controls the sidebar drawer.
- Backdrop and Escape close the drawer.
- Focus moves to the drawer's close control when opened and returns to the hamburger when closed.
- Create-task dialog is viewport-bounded and its content area can scroll independently of its footer.
- Reduced-motion users receive effectively disabled animation and transitions.

## 7. Color and Typography Tokens

Core CSS custom properties are defined in `styles.css`:

- `--paper`: warm gray page background.
- `--white`: clean surface.
- `--ink`: primary text.
- `--muted`: secondary text.
- `--line`: separators and borders.
- `--green` / `--green-dark`: primary action and active state.
- `--green-soft`: selected navigation background.
- `--coral`: small emphasis accent.
- `--blue`, `--yellow`: supporting status/category colors.

Priority semantics:

- High: coral/red.
- Medium: muted yellow.
- Low: green.

## 8. Component and Asset Architecture

- `index.html` owns page structure and modal form markup.
- `styles.css` owns visual tokens, desktop/mobile layout, dialog, drawer, and Select2 skin.
- `app.ts` owns UI state, filtering, sorting, formatting, and API interactions.
- `server.ts` serves the static assets and JSON API, authenticates users, validates task payloads, and persists data.
- Select2 and jQuery assets are served from local `node_modules` files to avoid relying on a runtime CDN.

## 9. Authentication and Data Flow

1. App startup requests `/api/auth/me`.
2. A signed-out response displays the auth screen; an authenticated response loads the workspace and the current user's tasks.
3. Registration/login creates an opaque random session token. Only its SHA-256 hash is stored in PostgreSQL.
4. The session token is set in an HttpOnly, SameSite=Lax cookie with a 14-day lifetime.
5. Task APIs resolve the session to a user and scope reads, updates, and deletes to that user ID.
6. Passwords are stored as salted scrypt hashes.

## 10. Current Technical Constraints

- No component framework or bundler is used.
- TypeScript is built with separate client and server configs.
- PostgreSQL support uses the `pg` connection pool and the `DATABASE_URL` environment variable.
- The CSS currently includes compact, grouped rules; new styles should continue to use the existing tokens and breakpoints (`950px`, `700px`, and `390px`).
