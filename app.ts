type Priority = 'low' | 'medium' | 'high';
type ViewFilter = 'all' | 'today' | 'upcoming' | 'completed';

interface Task {
  id: number;
  title: string;
  notes: string;
  category: string;
  priority: Priority;
  dueDate: string | null;
  completed: number;
  createdAt: string;
  updatedAt: string;
}

interface TaskDraft {
  title: string;
  notes: string;
  category: string;
  priority: Priority;
  dueDate: string | null;
}

interface User {
  id: number;
  name: string;
  email: string;
}

const taskList = document.querySelector<HTMLUListElement>('#task-list')!;
const emptyState = document.querySelector<HTMLDivElement>('#empty-state')!;
const searchInput = document.querySelector<HTMLInputElement>('#search')!;
const dialog = document.querySelector<HTMLDialogElement>('#task-dialog')!;
const taskForm = document.querySelector<HTMLFormElement>('#task-form')!;
const titleInput = document.querySelector<HTMLInputElement>('#task-title')!;
const authForm = document.querySelector<HTMLFormElement>('#auth-form')!;
const authScreen = document.querySelector<HTMLElement>('#auth-screen')!;
const appShell = document.querySelector<HTMLElement>('#app-shell')!;
const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const sidebarToggle = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
const sidebarClose = document.querySelector<HTMLButtonElement>('#sidebar-close')!;
const sidebarBackdrop = document.querySelector<HTMLButtonElement>('#sidebar-backdrop')!;
const state = { tasks: [] as Task[], filter: 'all' as ViewFilter, category: null as string | null, sortBy: 'priority' as 'priority' | 'dueDate' | 'createdAt', editingId: null as number | null, user: null as User | null, authMode: 'login' as 'login' | 'register' };

// setSidebarOpen controls the mobile sidebar.
// Think of it as a small UI helper: it toggles CSS classes and updates ARIA state.
// The open parameter is a boolean, so TypeScript can enforce a true/false value.
function setSidebarOpen(open: boolean): void {
  if (!window.matchMedia('(max-width: 700px)').matches) return;
  sidebar.classList.toggle('is-open', open);
  sidebarBackdrop.hidden = !open;
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  document.body.classList.toggle('sidebar-open', open);
  if (open) sidebarClose.focus();
  else sidebarToggle.focus();
}

// localDate turns any Date into a YYYY-MM-DD string.
// Default parameters are a common TypeScript pattern: if no value is passed, new Date() is used.
const localDate = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// escapeHtml protects text before it is inserted into HTML.
// This is important because task titles or notes may include characters like <, >, and ".
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

// formatDueDate converts a stored date into a friendly label like "Today" or "Tomorrow".
// TypeScript helps here because the function expects a string and returns a string too.
function formatDueDate(value: string): string {
  const normalized = value.length === 10 ? `${value}T23:59` : value.replace(' ', 'T');
  const date = new Date(normalized);
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86_400_000));
  const dateLabel = value.startsWith(today)
    ? 'Today'
    : value.startsWith(tomorrow)
      ? 'Tomorrow'
      : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  const timeLabel = value.length > 10
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
    : '';
  return timeLabel ? `${dateLabel}, ${timeLabel}` : dateLabel;
}

// formatCreatedAt formats the timestamp stored in the database into a readable local date/time.
// This keeps the UI user-friendly without changing the raw data in storage.
function formatCreatedAt(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

// localDateTime is similar to localDate, but includes hours and minutes.
// We use it for comparing due dates against the current time.
function localDateTime(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// visibleTasks returns only the tasks that match the current filter, category, and search term.
// It also sorts them before rendering, showing how a function can both compute and transform data.
function visibleTasks(): Task[] {
  const today = localDate();
  const query = searchInput.value.trim().toLowerCase();
  const tasks = state.tasks.filter((task) => {
    const due = task.dueDate;
    const matchesView = state.filter === 'all'
      || (state.filter === 'today' && !task.completed && due?.startsWith(today))
      || (state.filter === 'upcoming' && !task.completed && due !== null && due.slice(0, 10) > today)
      || (state.filter === 'completed' && Boolean(task.completed));
    const matchesCategory = state.category === null || task.category === state.category;
    const matchesSearch = !query || `${task.title} ${task.notes} ${task.category}`.toLowerCase().includes(query);
    return matchesView && matchesCategory && matchesSearch;
  });
  return tasks.sort((first, second) => {
    if (first.completed !== second.completed) return first.completed - second.completed;
    if (state.sortBy === 'priority') {
      const rank: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
      return rank[first.priority] - rank[second.priority] || compareCreatedAt(second, first);
    }
    if (state.sortBy === 'dueDate') {
      const firstDue = first.dueDate ?? '9999-12-31';
      const secondDue = second.dueDate ?? '9999-12-31';
      return firstDue.localeCompare(secondDue) || compareCreatedAt(second, first);
    }
    return compareCreatedAt(second, first);
  });
}

// compareCreatedAt compares two tasks by timestamp so the list stays predictable.
// This is a good example of a helper function: it keeps the sorting logic cleaner and reusable.
function compareCreatedAt(first: Task, second: Task): number {
  return first.createdAt.localeCompare(second.createdAt) || first.id - second.id;
}

// renderTask turns one Task object into an HTML string for the list view.
// This is a pure function: it uses inputs and returns a string without mutating the original task.
function renderTask(task: Task): string {
  const dueText = task.dueDate ? formatDueDate(task.dueDate) : 'No date';
  const dueComparable = task.dueDate?.length === 10 ? `${task.dueDate}T23:59` : task.dueDate?.replace(' ', 'T').slice(0, 16);
  const dueClass = dueComparable && dueComparable < localDateTime() && !task.completed ? 'is-overdue' : '';
  const note = task.notes ? `<p class="task-note">${escapeHtml(task.notes)}</p>` : '';
  const createdText = formatCreatedAt(task.createdAt);
  return `<li class="task-row${task.completed ? ' is-complete' : ''}" data-id="${task.id}">
    <label class="task-check"><input type="checkbox" data-action="toggle" aria-label="Mark ${escapeHtml(task.title)} ${task.completed ? 'incomplete' : 'complete'}" ${task.completed ? 'checked' : ''}><span></span></label>
    <div class="task-copy"><button class="task-name" data-action="edit" type="button">${escapeHtml(task.title)}</button>${note}<span class="task-category-mobile">${escapeHtml(task.category)}</span><span class="task-created-mobile">Created ${escapeHtml(createdText)}</span></div>
    <span class="priority-pill priority-${task.priority}"><span></span>${task.priority}</span>
    <span class="created-date" title="Created ${escapeHtml(createdText)}">${escapeHtml(createdText)}</span>
    <span class="due-date ${dueClass}"><span class="due-icon" aria-hidden="true"></span>${dueText}</span>
    <button class="row-menu" data-action="edit" type="button" aria-label="Edit ${escapeHtml(task.title)}" title="Edit task">···</button>
  </li>`;
}

// renderCategories rebuilds the category navigation from the current task list.
// It shows how a function can derive UI from data and then attach click behavior to each button.
function renderCategories(): void {
  const categoryCounts = new Map<string, number>();
  for (const task of state.tasks) categoryCounts.set(task.category, (categoryCounts.get(task.category) ?? 0) + 1);
  const nav = document.querySelector<HTMLElement>('#category-nav')!;
  const categories = [...categoryCounts.keys()].sort((first, second) => first.localeCompare(second));
  nav.innerHTML = categories.map((category, index) => `<button class="category-item${state.category === category ? ' is-active' : ''}" type="button" data-category="${escapeHtml(category)}"><span class="category-swatch swatch-${index % 5}"></span><span>${escapeHtml(category)}</span><span class="nav-count">${categoryCounts.get(category)}</span></button>`).join('');
  nav.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) => {
    button.addEventListener('click', () => {
      state.category = state.category === button.dataset.category ? null : button.dataset.category!;
      setSidebarOpen(false);
      render();
    });
  });
}

// render is the main UI refresh function.
// It reads current state, filters and sorts tasks, then updates the DOM with the newest data.
function render(): void {
  const tasks = visibleTasks();
  taskList.innerHTML = tasks.map(renderTask).join('');
  document.querySelector('#result-count')!.textContent = String(tasks.length).padStart(2, '0');
  emptyState.hidden = tasks.length > 0;
  document.querySelector<HTMLButtonElement>('#quick-add')!.hidden = tasks.length === 0;
  if (tasks.length === 0) {
    const isSearch = Boolean(searchInput.value.trim());
    document.querySelector('#empty-title')!.textContent = isSearch ? 'No matches found' : state.filter === 'all' && state.tasks.length === 0 ? 'A clean slate.' : 'Nothing on the list';
    document.querySelector('#empty-copy')!.textContent = isSearch ? 'Try a different search, or clear the field.' : 'Take a breath, or add a task to get moving.';
  }

  const today = localDate();
  const open = state.tasks.filter((task) => !task.completed);
  const dueToday = open.filter((task) => task.dueDate?.startsWith(today)).length;
  const completed = state.tasks.filter((task) => Boolean(task.completed)).length;
  const dueUpcoming = open.filter((task) => task.dueDate !== null && task.dueDate.slice(0, 10) > today).length;
  document.querySelector('#count-all')!.textContent = String(state.tasks.length);
  document.querySelector('#count-today')!.textContent = String(dueToday);
  document.querySelector('#count-upcoming')!.textContent = String(dueUpcoming);
  document.querySelector('#count-completed')!.textContent = String(completed);
  document.querySelector('#stat-open')!.textContent = String(open.length).padStart(2, '0');
  document.querySelector('#stat-due')!.textContent = String(dueToday).padStart(2, '0');
  const completionRate = state.tasks.length ? Math.round(completed / state.tasks.length * 100) : 0;
  document.querySelector('#stat-rate')!.innerHTML = `${completionRate}<span>%</span>`;
  document.querySelector('#focus-done')!.textContent = `${completed} done`;
  document.querySelector('#focus-total')!.textContent = `${state.tasks.length} ${state.tasks.length === 1 ? 'task' : 'tasks'}`;
  (document.querySelector('#focus-progress') as HTMLElement).style.width = `${completionRate}%`;
  document.querySelector('#focus-copy')!.innerHTML = open.length === 0 && state.tasks.length > 0 ? 'Everything handled.<br>Enjoy the space.' : 'A fresh page.<br>Make it count.';

  const activeButton = document.querySelector<HTMLButtonElement>(`[data-filter="${state.filter}"]`)!;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button === activeButton));
  const filterTitles: Record<ViewFilter, string> = { all: 'All tasks', today: 'Today', upcoming: 'Upcoming', completed: 'Completed' };
  const title = state.category ?? filterTitles[state.filter];
  document.querySelector('#crumb-view')!.textContent = title;
  document.querySelector('#page-title')!.innerHTML = `${escapeHtml(title)}<span class="title-period">.</span>`;
  document.querySelector('#list-title')!.textContent = state.category ? `${state.category} list` : state.filter === 'all' ? 'Your list' : `${title} list`;
  document.querySelector('#page-eyebrow')!.textContent = state.filter === 'today' ? 'ONE DAY, ONE THING AT A TIME' : state.filter === 'completed' ? 'LOOK HOW FAR YOU HAVE COME' : 'YOUR SPACE, IN ORDER';
  renderCategories();
}

// request wraps fetch with a typed, reusable API call.
// It returns the JSON data on success and throws a clear error when the backend responds with an error.
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Something went wrong.' })) as { error?: string };
    throw new Error(body.error ?? 'Something went wrong.');
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

// refreshTasks asks the server for the current tasks and then re-renders the list.
// This is the typical pattern for keeping UI in sync with backend data.
async function refreshTasks(): Promise<void> {
  state.tasks = await request<Task[]>('/api/tasks');
  render();
}

// setAuthMode swaps the UI between login and registration modes.
// Using a union type ('login' | 'register') helps TypeScript catch mistakes automatically.
function setAuthMode(mode: 'login' | 'register'): void {
  state.authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#auth-title')!.innerHTML = registering ? 'Create your space<span>.</span>' : 'Welcome back<span>.</span>';
  document.querySelector('#auth-intro')!.textContent = registering ? 'Set up an account to keep your tasks in sync.' : 'Sign in to pick up where you left off.';
  document.querySelector('#auth-name-field')!.toggleAttribute('hidden', !registering);
  document.querySelector<HTMLInputElement>('#auth-name')!.required = registering;
  document.querySelector<HTMLInputElement>('#auth-password')!.autocomplete = registering ? 'new-password' : 'current-password';
  document.querySelector('#auth-switch-copy')!.textContent = registering ? 'Already have an account?' : 'New to HCM?';
  document.querySelector('#auth-switch')!.textContent = registering ? 'Sign in' : 'Create an account';
  document.querySelector('#auth-submit')!.innerHTML = registering ? 'Create account <span aria-hidden="true">→</span>' : 'Sign in <span aria-hidden="true">→</span>';
  document.querySelector('#password-hint')!.textContent = registering ? '10 characters minimum' : '';
  authForm.reset();
  document.querySelector<HTMLElement>('#auth-error')!.hidden = true;
}

// showAuthenticatedWorkspace updates the app to the logged-in view.
// A function like this keeps UI state changes in one place instead of repeating DOM logic everywhere.
function showAuthenticatedWorkspace(user: User): void {
  state.user = user;
  document.querySelector('#profile-name')!.textContent = user.name;
  document.querySelector('#profile-avatar')!.textContent = user.name.slice(0, 1).toUpperCase();
  authScreen.hidden = true;
  appShell.hidden = false;
}

// showSignIn resets the page to the unauthenticated screen.
// It clears the current task list and hides the workspace area until a user signs in.
function showSignIn(): void {
  state.user = null;
  state.tasks = [];
  authScreen.hidden = false;
  appShell.hidden = true;
}

// populateTaskLists fills the dropdown with category choices.
// It makes a reusable UI population helper instead of hard-coding the options in multiple places.
function populateTaskLists(selectedCategory?: string): void {
  const categorySelect = document.querySelector<HTMLSelectElement>('#task-category')!;
  categorySelect.replaceChildren(new Option('Personal', 'Personal'), new Option('Work', 'Work'));
  categorySelect.value = selectedCategory === 'Work' ? 'Work' : 'Personal';
}

// initializeSelectControls sets up the fancy select menu used for task priority.
// It demonstrates a function that configures third-party UI and event handlers.
function initializeSelectControls(): void {
  $('#task-priority').select2({
    width: '100%',
    minimumResultsForSearch: 0,
    dropdownParent: $('#task-dialog'),
    templateResult: (option) => {
      if (!option.id) return option.text;
      const color = option.id === 'high' ? 'var(--coral)' : option.id === 'medium' ? 'var(--yellow)' : '#6e9a7e';
      return $(`<span class="select2-priority-option"><span style="--priority-color:${color}"></span>${option.text}</span>`);
    },
  });
  $('#task-priority').on('select2:select', (event) => {
    $(event.currentTarget).select2('close');
  });

}

// startApp runs when the app loads.
// It checks whether the user is already signed in and loads their task data if they are.
async function startApp(): Promise<void> {
  try {
    const user = await request<User | null>('/api/auth/me');
    if (!user) {
      setAuthMode('login');
      showSignIn();
      return;
    }
    showAuthenticatedWorkspace(user);
    await refreshTasks();
  } catch {
    setAuthMode('login');
    showSignIn();
  }
}

// openDialog fills in the task modal with either new task values or an existing task for editing.
// This is a good example of a function that prepares form data based on runtime state.
function openDialog(task?: Task): void {
  state.editingId = task?.id ?? null;
  document.querySelector('#dialog-kicker')!.textContent = task ? 'EDIT TASK' : 'NEW TASK';
  document.querySelector('#dialog-title')!.innerHTML = task ? 'Keep it moving<span>.</span>' : 'Make it happen<span>.</span>';
  document.querySelector('#save-task')!.innerHTML = task ? 'Save changes <span aria-hidden="true">→</span>' : 'Add task <span aria-hidden="true">→</span>';
  document.querySelector<HTMLButtonElement>('#delete-task')!.hidden = !task;
  taskForm.reset();
  (document.querySelector<HTMLInputElement>('#task-title')!).value = task?.title ?? '';
  (document.querySelector<HTMLTextAreaElement>('#task-notes')!).value = task?.notes ?? '';
  populateTaskLists(task?.category ?? state.category ?? undefined);
  (document.querySelector<HTMLInputElement>('#task-due')!).value = task?.dueDate?.replace(' ', 'T').slice(0, 16) ?? '';
  $('#task-priority').val(task?.priority ?? 'medium').trigger('change.select2');
  dialog.showModal();
  titleInput.focus();
}

// showError displays a user-friendly error in the page.
// It accepts unknown because network or runtime errors can come in many shapes.
function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  const subtitle = document.querySelector<HTMLElement>('#page-subtitle')!;
  subtitle.textContent = message;
  subtitle.classList.add('error-message');
  window.setTimeout(() => subtitle.classList.remove('error-message'), 3200);
}

// draftFromForm collects the current form inputs and returns a strongly typed task object.
// This keeps the form-to-server data flow clear and type-safe.
function draftFromForm(): TaskDraft {
  const data = new FormData(taskForm);
  return {
    title: String(data.get('title') ?? '').trim(),
    notes: String(data.get('notes') ?? '').trim(),
    category: String(data.get('category') ?? '').trim() || 'Personal',
    priority: String(data.get('priority') ?? 'medium') as Priority,
    dueDate: String(data.get('dueDate') ?? '') || null,
  };
}

document.querySelectorAll<HTMLButtonElement>('#new-task, #heading-new-task, #quick-add, #empty-add').forEach((button) => button.addEventListener('click', () => openDialog()));
document.querySelector('#dialog-close')!.addEventListener('click', () => dialog.close());
document.querySelector('#cancel-task')!.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

taskForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = state.editingId;
  const button = document.querySelector<HTMLButtonElement>('#save-task')!;
  button.disabled = true;
  try {
    await request(id ? `/api/tasks/${id}` : '/api/tasks', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(draftFromForm()) });
    dialog.close();
    await refreshTasks();
  } catch (error) { showError(error); } finally { button.disabled = false; }
});

document.querySelector('#delete-task')!.addEventListener('click', async () => {
  const id = state.editingId;
  if (!id || !window.confirm('Delete this task? This cannot be undone.')) return;
  try {
    await request<void>(`/api/tasks/${id}`, { method: 'DELETE' });
    dialog.close();
    await refreshTasks();
  } catch (error) { showError(error); }
});

taskList.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  const row = target.closest<HTMLElement>('[data-id]');
  if (!action || !row) return;
  const task = state.tasks.find((item) => item.id === Number(row.dataset.id));
  if (!task) return;
  if (action === 'edit' && target.closest('button')) openDialog(task);
  if (action === 'toggle' && target instanceof HTMLInputElement) {
    try {
      await request(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ completed: target.checked }) });
      await refreshTasks();
    } catch (error) { showError(error); }
  }
});

document.querySelector('#primary-nav')!.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  state.filter = button.dataset.filter as ViewFilter;
  state.category = null;
  setSidebarOpen(false);
  render();
});

document.querySelector<HTMLSelectElement>('#task-sort')!.addEventListener('change', (event) => {
  state.sortBy = (event.currentTarget as HTMLSelectElement).value as typeof state.sortBy;
  render();
});

sidebarToggle.addEventListener('click', () => setSidebarOpen(true));
sidebarClose.addEventListener('click', () => setSidebarOpen(false));
sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
window.addEventListener('resize', () => {
  if (window.matchMedia('(max-width: 700px)').matches) return;
  sidebar.classList.remove('is-open');
  sidebarBackdrop.hidden = true;
  sidebarToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-open');
});

document.querySelector('#auth-switch')!.addEventListener('click', () => {
  setAuthMode(state.authMode === 'login' ? 'register' : 'login');
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = document.querySelector<HTMLButtonElement>('#auth-submit')!;
  const errorMessage = document.querySelector<HTMLElement>('#auth-error')!;
  submit.disabled = true;
  errorMessage.hidden = true;
  const form = new FormData(authForm);
  const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const credentials = {
    name: String(form.get('name') ?? '').trim(),
    email: String(form.get('email') ?? '').trim(),
    password: String(form.get('password') ?? ''),
  };
  try {
    const user = await request<User>(endpoint, { method: 'POST', body: JSON.stringify(credentials) });
    showAuthenticatedWorkspace(user);
    await refreshTasks();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : 'Unable to sign in. Please try again.';
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#logout')!.addEventListener('click', async () => {
  try {
    await request<void>('/api/auth/logout', { method: 'POST' });
    showSignIn();
  } catch (error) { showError(error); }
});

searchInput.addEventListener('input', render);
document.querySelector('#footer-date')!.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
document.querySelector('#date-stamp')!.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  if (event.key === 'Escape' && sidebar.classList.contains('is-open')) { setSidebarOpen(false); return; }
  if (!typing && event.key.toLowerCase() === 'n') { event.preventDefault(); openDialog(); }
  if (!typing && event.key === '/') { event.preventDefault(); searchInput.focus(); }
});

initializeSelectControls();
void startApp();