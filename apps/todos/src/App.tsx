import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Edit3,
  Filter,
  Flag,
  Import,
  LayoutGrid,
  ListTodo,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';

type Priority = 'P0' | 'P1' | 'P2' | 'P3';
type Status = 'todo' | 'doing' | 'blocked' | 'done';
type Owner = 'Nick' | 'David' | 'Facundo' | 'Santiago';
type Size = 'XS' | 'S' | 'M' | 'L' | 'XL';
type ViewMode = 'board' | 'list';
type SortMode = 'date' | 'priority' | 'size' | 'updated';

type TodoItem = {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  todoDate: string;
  blockers: string;
  status: Status;
  owner: Owner;
  size: Size;
  area: string;
  createdAt: string;
  updatedAt: string;
};

type TodoDraft = Omit<TodoItem, 'id' | 'createdAt' | 'updatedAt'>;

const STORAGE_KEY = 'donna.todos.v7';
const LEGACY_STORAGE_KEYS = ['donna.todos.v6', 'donna.todos.v5', 'donna.todos.v4', 'donna.todos.v3', 'donna.todos.v2', 'donna.todos.v1'];
const legacySeedIds = new Set([
  'seed-reminder-retry-ui',
  'seed-mobile-onboarding-pass',
  'seed-call-quality-triage',
  'seed-privacy-checklist',
]);

const statusColumns: Array<{ id: Status; title: string; icon: typeof Circle }> = [
  { id: 'todo', title: 'Todo', icon: Circle },
  { id: 'doing', title: 'In Progress', icon: RotateCcw },
  { id: 'blocked', title: 'Blocked', icon: AlertTriangle },
  { id: 'done', title: 'Done', icon: Check },
];

const priorityOrder: Priority[] = ['P0', 'P1', 'P2', 'P3'];
const ownerOptions: Owner[] = ['Nick', 'David', 'Facundo', 'Santiago'];
const sizeOrder: Size[] = ['XS', 'S', 'M', 'L', 'XL'];

const priorityMeta: Record<Priority, { label: string; short: string }> = {
  P0: { label: 'Urgent', short: 'P0' },
  P1: { label: 'High', short: 'P1' },
  P2: { label: 'Medium', short: 'P2' },
  P3: { label: 'Low', short: 'P3' },
};

const sizeMeta: Record<Size, { label: string }> = {
  XS: { label: 'Tiny' },
  S: { label: 'Small' },
  M: { label: 'Medium' },
  L: { label: 'Large' },
  XL: { label: 'XL' },
};

const areaOptions = [
  'Product',
  'Voice',
  'Mobile',
  'Admin',
  'Website',
  'Observability',
  'Ops',
  'Growth',
  'Compliance',
  'QA',
  'Infrastructure',
  'Docs',
];

const emptyDraft: TodoDraft = {
  title: '',
  description: '',
  priority: 'P1',
  todoDate: toDateInputValue(new Date()),
  blockers: '',
  status: 'todo',
  owner: 'David',
  size: 'M',
  area: 'Product',
};

function App() {
  const [todos, setTodos] = useState<TodoItem[]>(loadTodos);
  const [draft, setDraft] = useState<TodoDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<Status | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [sortMode, setSortMode] = useState<SortMode>('date');
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }, [todos]);

  useEffect(() => {
    if (!selectedTodoId) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setSelectedTodoId(null);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTodoId]);

  const filteredTodos = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = todos.filter(todo => {
      const matchesQuery =
        !normalizedQuery ||
        [todo.title, todo.description, todo.blockers, todo.owner, todo.size, todo.area]
          .join(' ')
          .toLowerCase()
          .includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' || todo.status === statusFilter;
      const matchesPriority = priorityFilter === 'all' || todo.priority === priorityFilter;
      return matchesQuery && matchesStatus && matchesPriority;
    });

    return filtered.sort((a, b) => {
      if (sortMode === 'priority') {
        return priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority);
      }

      if (sortMode === 'updated') {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }

      if (sortMode === 'size') {
        return sizeOrder.indexOf(b.size) - sizeOrder.indexOf(a.size);
      }

      return new Date(a.todoDate).getTime() - new Date(b.todoDate).getTime();
    });
  }, [priorityFilter, query, sortMode, statusFilter, todos]);

  const activeColumns = statusColumns.filter(column => !isClosedStatus(column.id));
  const closedGroups = statusColumns.filter(column => isClosedStatus(column.id));

  const metrics = useMemo(() => {
    return {
      total: todos.length,
      open: todos.filter(todo => !isClosedStatus(todo.status)).length,
      blocked: todos.filter(todo => !isClosedStatus(todo.status) && (todo.status === 'blocked' || todo.blockers.trim())).length,
      urgent: todos.filter(todo => !isClosedStatus(todo.status) && todo.priority === 'P0').length,
      dueToday: todos.filter(todo => !isClosedStatus(todo.status) && dueState(todo) === 'today').length,
      overdue: todos.filter(todo => !isClosedStatus(todo.status) && dueState(todo) === 'overdue').length,
      done: todos.filter(todo => todo.status === 'done').length,
    };
  }, [todos]);

  const editingTodo = editingId ? todos.find(todo => todo.id === editingId) : null;
  const selectedTodo = selectedTodoId ? todos.find(todo => todo.id === selectedTodoId) : null;
  const isEditing = Boolean(editingTodo);

  function submitTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title.trim()) {
      titleInputRef.current?.focus();
      return;
    }

    const now = new Date().toISOString();

    if (editingId) {
      setTodos(current =>
        current.map(todo =>
          todo.id === editingId
            ? {
                ...todo,
                ...normalizeDraft(draft),
                updatedAt: now,
              }
            : todo,
        ),
      );
      clearForm();
      return;
    }

    setTodos(current => [
      {
        id: createId(),
        ...normalizeDraft(draft),
        createdAt: now,
        updatedAt: now,
      },
      ...current,
    ]);
    clearForm();
  }

  function editTodo(todo: TodoItem) {
    setEditingId(todo.id);
    setDraft({
      title: todo.title,
      description: todo.description,
      priority: todo.priority,
      todoDate: todo.todoDate,
      blockers: todo.blockers,
      status: todo.status,
      owner: todo.owner,
      size: todo.size,
      area: todo.area,
    });
    requestAnimationFrame(() => titleInputRef.current?.focus());
  }

  function openDetails(todo: TodoItem) {
    setSelectedTodoId(todo.id);
  }

  function closeDetails() {
    setSelectedTodoId(null);
  }

  function clearForm() {
    setEditingId(null);
    setDraft({ ...emptyDraft, todoDate: toDateInputValue(new Date()) });
  }

  function updateStatus(id: string, status: Status) {
    setTodos(current =>
      current.map(todo =>
        todo.id === id
          ? {
              ...todo,
              status,
              updatedAt: new Date().toISOString(),
            }
          : todo,
      ),
    );
  }

  function deleteTodo(id: string) {
    setTodos(current => current.filter(todo => todo.id !== id));
    if (editingId === id) {
      clearForm();
    }
    if (selectedTodoId === id) {
      setSelectedTodoId(null);
    }
  }

  function exportTodos() {
    const blob = new Blob([JSON.stringify(todos, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `donna-todos-${toDateInputValue(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function importTodos(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed)) return;
        const imported = parsed.map(coerceTodoItem).filter((todo): todo is TodoItem => Boolean(todo));
        if (imported.length > 0) {
          setTodos(imported);
          clearForm();
        }
      } catch {
        return;
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  }

  function handleDrop(status: Status) {
    if (draggingId) {
      updateStatus(draggingId, status);
      setDraggingId(null);
    }
  }

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="Primary">
        <div className="brand-mark" title="Donna Todos">
          D
        </div>
        <nav className="rail-nav" aria-label="View">
          <button
            type="button"
            className={viewMode === 'board' ? 'active' : ''}
            aria-label="Board view"
            title="Board view"
            onClick={() => setViewMode('board')}
          >
            <LayoutGrid size={20} />
          </button>
          <button
            type="button"
            className={viewMode === 'list' ? 'active' : ''}
            aria-label="List view"
            title="List view"
            onClick={() => setViewMode('list')}
          >
            <ListTodo size={20} />
          </button>
        </nav>
        <div className="rail-actions">
          <button type="button" aria-label="Import todos" title="Import todos" onClick={() => fileInputRef.current?.click()}>
            <Import size={20} />
          </button>
          <button type="button" aria-label="Export todos" title="Export todos" onClick={exportTodos}>
            <Download size={20} />
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="page-header">
          <div className="title-group">
            <span className="eyebrow">Internal Tracker</span>
            <h1>Donna Todos</h1>
          </div>
          <div className="header-actions">
            <div className="view-toggle" role="group" aria-label="Change view">
              <button
                type="button"
                className={viewMode === 'board' ? 'active' : ''}
                onClick={() => setViewMode('board')}
              >
                Board
              </button>
              <button
                type="button"
                className={viewMode === 'list' ? 'active' : ''}
                onClick={() => setViewMode('list')}
              >
                List
              </button>
            </div>
            <button type="button" className="primary-action" onClick={() => titleInputRef.current?.focus()}>
              <Plus size={18} />
              New Todo
            </button>
          </div>
        </header>

        <section className="metric-strip" aria-label="Todo metrics">
          <Metric label="Open" value={metrics.open} tone="blue" />
          <Metric label="Blocked" value={metrics.blocked} tone="red" />
          <Metric label="P0" value={metrics.urgent} tone="orange" />
          <Metric label="Done" value={metrics.done} tone="neutral" />
        </section>

        <section className="control-row" aria-label="Filters">
          <label className="search-box">
            <Search size={18} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search title, owner, blocker"
            />
          </label>
          <label className="compact-select">
            <Filter size={17} />
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as Status | 'all')}>
              <option value="all">All statuses</option>
              {statusColumns.map(status => (
                <option key={status.id} value={status.id}>
                  {status.title}
                </option>
              ))}
            </select>
          </label>
          <label className="compact-select">
            <Flag size={17} />
            <select value={priorityFilter} onChange={event => setPriorityFilter(event.target.value as Priority | 'all')}>
              <option value="all">All priorities</option>
              {priorityOrder.map(priority => (
                <option key={priority} value={priority}>
                  {priorityMeta[priority].short} {priorityMeta[priority].label}
                </option>
              ))}
            </select>
          </label>
          <label className="compact-select">
            <CalendarDays size={17} />
            <select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)}>
              <option value="date">Todo date</option>
              <option value="priority">Priority</option>
              <option value="size">Effort size</option>
              <option value="updated">Updated</option>
            </select>
          </label>
        </section>

        <PriorityDrawers
          todos={todos}
          onEdit={editTodo}
          onDelete={deleteTodo}
          onOpenDetails={openDetails}
          onStatusChange={updateStatus}
        />

        <div className="content-grid">
          <section className="tracker-surface" aria-label="Todos">
            {viewMode === 'board' ? (
              <>
                <div className="board">
                  {activeColumns.map(column => {
                    const columnTodos = filteredTodos.filter(todo => todo.status === column.id);
                    const Icon = column.icon;

                    return (
                      <section
                        className={`board-column column-${column.id}`}
                        key={column.id}
                        onDragOver={event => event.preventDefault()}
                        onDrop={() => handleDrop(column.id)}
                      >
                        <header className="column-header">
                          <span>
                            <Icon size={18} />
                            {column.title}
                          </span>
                          <strong>{columnTodos.length}</strong>
                        </header>
                        <div className="card-stack">
                          {columnTodos.map(todo => (
                            <TodoCard
                              key={todo.id}
                              todo={todo}
                              onEdit={editTodo}
                              onDelete={deleteTodo}
                              onOpenDetails={openDetails}
                              onStatusChange={updateStatus}
                              onDragStart={setDraggingId}
                            />
                          ))}
                          {columnTodos.length === 0 && <div className="empty-column">No todos</div>}
                        </div>
                      </section>
                    );
                  })}
                </div>
                <div className="closed-work" aria-label="Closed todos">
                  {closedGroups.map(group => (
                    <ClosedWorkGroup
                      key={group.id}
                      status={group.id}
                      title={group.title}
                      todos={filteredTodos.filter(todo => todo.status === group.id)}
                      onEdit={editTodo}
                      onDelete={deleteTodo}
                      onOpenDetails={openDetails}
                      onStatusChange={updateStatus}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className="todo-table-wrap">
                <table className="todo-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Priority</th>
                      <th>Size</th>
                      <th>Status</th>
                      <th>Todo Date</th>
                      <th>Owner</th>
                      <th>Blockers</th>
                      <th aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTodos.map(todo => (
                      <tr key={todo.id} className={isClosedStatus(todo.status) ? `row-${todo.status}` : undefined}>
                        <td>
                          <strong>{todo.title}</strong>
                          <DescriptionButton todo={todo} onOpenDetails={openDetails} variant="table" />
                        </td>
                        <td>
                          <PriorityBadge priority={todo.priority} />
                        </td>
                        <td>
                          <SizeBadge size={todo.size} />
                        </td>
                        <td>
                          <StatusBadge status={todo.status} />
                        </td>
                        <td>
                          <DueDate todo={todo} />
                        </td>
                        <td>{todo.owner}</td>
                        <td className={todo.blockers ? 'blocker-cell' : ''}>{todo.blockers || 'None'}</td>
                        <td>
                          <div className="table-actions">
                            <button type="button" aria-label={`Edit ${todo.title}`} onClick={() => editTodo(todo)}>
                              <Edit3 size={17} />
                            </button>
                            <button type="button" aria-label={`Delete ${todo.title}`} onClick={() => deleteTodo(todo.id)}>
                              <Trash2 size={17} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredTodos.length === 0 && <EmptyState onReset={() => setQuery('')} />}
              </div>
            )}
          </section>

          <aside className="side-panel">
            <form className="todo-form" onSubmit={submitTodo}>
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">{isEditing ? 'Edit Todo' : 'New Todo'}</span>
                  <h2>{isEditing ? editingTodo?.title : 'Add work'}</h2>
                </div>
                {isEditing && (
                  <button type="button" className="icon-button" aria-label="Cancel edit" onClick={clearForm}>
                    <X size={18} />
                  </button>
                )}
              </div>

              <label className="field full">
                <span>Title</span>
                <input
                  ref={titleInputRef}
                  value={draft.title}
                  onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                  placeholder="e.g. Finish reminder retry UI"
                  required
                />
              </label>

              <label className="field full">
                <span>Description</span>
                <textarea
                  value={draft.description}
                  onChange={event => setDraft(current => ({ ...current, description: event.target.value }))}
                  rows={4}
                  placeholder="Scope, acceptance notes, links"
                />
              </label>

              <div className="form-grid">
                <label className="field">
                  <span>Priority</span>
                  <select
                    value={draft.priority}
                    onChange={event => setDraft(current => ({ ...current, priority: event.target.value as Priority }))}
                  >
                    {priorityOrder.map(priority => (
                      <option key={priority} value={priority}>
                        {priorityMeta[priority].short} {priorityMeta[priority].label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Status</span>
                  <select
                    value={draft.status}
                    onChange={event => setDraft(current => ({ ...current, status: event.target.value as Status }))}
                  >
                    {statusColumns.map(status => (
                      <option key={status.id} value={status.id}>
                        {status.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Effort / Size</span>
                  <select value={draft.size} onChange={event => setDraft(current => ({ ...current, size: event.target.value as Size }))}>
                    {sizeOrder.map(size => (
                      <option key={size} value={size}>
                        {size} {sizeMeta[size].label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Todo Date</span>
                  <input
                    type="date"
                    value={draft.todoDate}
                    onChange={event => setDraft(current => ({ ...current, todoDate: event.target.value }))}
                  />
                </label>

                <label className="field">
                  <span>Area</span>
                  <select value={draft.area} onChange={event => setDraft(current => ({ ...current, area: event.target.value }))}>
                    {areaOptions.map(area => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field full">
                <span>Owner</span>
                <select value={draft.owner} onChange={event => setDraft(current => ({ ...current, owner: event.target.value as Owner }))}>
                  {ownerOptions.map(owner => (
                    <option key={owner} value={owner}>
                      {owner}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field full">
                <span>Blockers</span>
                <textarea
                  value={draft.blockers}
                  onChange={event => setDraft(current => ({ ...current, blockers: event.target.value }))}
                  rows={3}
                  placeholder="Dependency, decision, or unknown"
                />
              </label>

              <div className="form-actions">
                <button type="submit" className="primary-action">
                  {isEditing ? <Check size={18} /> : <Plus size={18} />}
                  {isEditing ? 'Save' : 'Add Todo'}
                </button>
                <button type="button" className="secondary-action" onClick={clearForm}>
                  Clear
                </button>
              </div>
            </form>

            <section className="focus-panel" aria-label="Focus">
              <div className="panel-heading compact">
                <div>
                  <span className="eyebrow">Focus</span>
                  <h2>Today</h2>
                </div>
                <span className="mini-count">{metrics.dueToday + metrics.overdue}</span>
              </div>
              <div className="focus-list">
                {todos
                  .filter(todo => !isClosedStatus(todo.status) && ['today', 'overdue'].includes(dueState(todo)))
                  .sort((a, b) => new Date(a.todoDate).getTime() - new Date(b.todoDate).getTime())
                  .slice(0, 5)
                  .map(todo => (
                    <button key={todo.id} type="button" className="focus-item" onClick={() => editTodo(todo)}>
                      <span>{todo.title}</span>
                      <DueDate todo={todo} />
                    </button>
                  ))}
                {metrics.dueToday + metrics.overdue === 0 && <div className="empty-focus">No urgent dates</div>}
              </div>
            </section>
          </aside>
        </div>
      </main>

      <input ref={fileInputRef} type="file" accept="application/json" hidden onChange={importTodos} />
      {selectedTodo && (
        <TodoDetailsDialog
          todo={selectedTodo}
          onClose={closeDetails}
          onEdit={todo => {
            closeDetails();
            editTodo(todo);
          }}
          onDelete={deleteTodo}
          onStatusChange={updateStatus}
        />
      )}
    </div>
  );
}

function TodoCard({
  todo,
  onEdit,
  onDelete,
  onOpenDetails,
  onStatusChange,
  onDragStart,
}: {
  todo: TodoItem;
  onEdit: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onOpenDetails: (todo: TodoItem) => void;
  onStatusChange: (id: string, status: Status) => void;
  onDragStart: (id: string) => void;
}) {
  const currentIndex = statusColumns.findIndex(status => status.id === todo.status);
  const previousStatus = statusColumns[currentIndex - 1]?.id;
  const nextStatus = statusColumns[currentIndex + 1]?.id;

  return (
    <article className={`todo-card card-priority-${todo.priority.toLowerCase()}`} draggable onDragStart={() => onDragStart(todo.id)}>
      <div className="card-topline">
        <div className="badge-row">
          <PriorityBadge priority={todo.priority} />
          <SizeBadge size={todo.size} />
        </div>
        <DueDate todo={todo} />
      </div>
      <h3>{todo.title}</h3>
      <DescriptionButton todo={todo} onOpenDetails={onOpenDetails} variant="card" />
      <div className="card-meta">
        <span>{todo.area}</span>
        <span>{todo.owner}</span>
      </div>
      {todo.blockers && (
        <div className="blocker-note">
          <AlertTriangle size={16} />
          <span>{todo.blockers}</span>
        </div>
      )}
      <div className="card-actions">
        <button
          type="button"
          aria-label={`Move ${todo.title} backward`}
          disabled={!previousStatus}
          onClick={() => previousStatus && onStatusChange(todo.id, previousStatus)}
        >
          <ChevronLeft size={17} />
        </button>
        <button type="button" aria-label={`Edit ${todo.title}`} onClick={() => onEdit(todo)}>
          <Edit3 size={17} />
        </button>
        <button type="button" aria-label={`Delete ${todo.title}`} onClick={() => onDelete(todo.id)}>
          <Trash2 size={17} />
        </button>
        <button
          type="button"
          aria-label={`Move ${todo.title} forward`}
          disabled={!nextStatus}
          onClick={() => nextStatus && onStatusChange(todo.id, nextStatus)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
    </article>
  );
}

function PriorityDrawers({
  todos,
  onEdit,
  onDelete,
  onOpenDetails,
  onStatusChange,
}: {
  todos: TodoItem[];
  onEdit: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onOpenDetails: (todo: TodoItem) => void;
  onStatusChange: (id: string, status: Status) => void;
}) {
  return (
    <section className="priority-drawers" aria-label="Priority groups">
      {priorityOrder.map(priority => {
        const priorityTodos = todos.filter(todo => todo.priority === priority).sort(compareTodosForDrawer);

        return (
          <details className={`priority-drawer priority-drawer-${priority.toLowerCase()}`} key={priority}>
            <summary className="drawer-summary">
              <span className="drawer-summary-main">
                <ChevronRight className="drawer-chevron" size={18} />
                <PriorityBadge priority={priority} />
              </span>
              <span className="drawer-count">{priorityTodos.length}</span>
            </summary>
            <div className="drawer-list">
              {priorityTodos.map(todo => (
                <TodoExpandableRow
                  key={todo.id}
                  todo={todo}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onOpenDetails={onOpenDetails}
                  onStatusChange={onStatusChange}
                />
              ))}
              {priorityTodos.length === 0 && <div className="empty-drawer">No todos</div>}
            </div>
          </details>
        );
      })}
    </section>
  );
}

function ClosedWorkGroup({
  status,
  title,
  todos,
  onEdit,
  onDelete,
  onOpenDetails,
  onStatusChange,
}: {
  status: Status;
  title: string;
  todos: TodoItem[];
  onEdit: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onOpenDetails: (todo: TodoItem) => void;
  onStatusChange: (id: string, status: Status) => void;
}) {
  const column = statusColumns.find(item => item.id === status);
  const Icon = column?.icon ?? Check;
  const sortedTodos = [...todos].sort(compareTodosForDrawer);

  return (
    <details className={`closed-group closed-status-${status}`} open>
      <summary className="closed-summary">
        <span className="closed-summary-main">
          <ChevronRight className="drawer-chevron" size={18} />
          <Icon size={18} />
          {title}
        </span>
        <span className="drawer-count">{sortedTodos.length}</span>
      </summary>
      <div className="drawer-list">
        {sortedTodos.map(todo => (
          <TodoExpandableRow
            key={todo.id}
            todo={todo}
            onEdit={onEdit}
            onDelete={onDelete}
            onOpenDetails={onOpenDetails}
            onStatusChange={onStatusChange}
          />
        ))}
        {sortedTodos.length === 0 && <div className="empty-drawer">No done todos</div>}
      </div>
    </details>
  );
}

function TodoExpandableRow({
  todo,
  onEdit,
  onDelete,
  onOpenDetails,
  onStatusChange,
}: {
  todo: TodoItem;
  onEdit: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onOpenDetails: (todo: TodoItem) => void;
  onStatusChange: (id: string, status: Status) => void;
}) {
  return (
    <details className={`expandable-row row-${todo.status} row-priority-${todo.priority.toLowerCase()}`}>
      <summary className="expandable-summary">
        <ChevronRight className="row-chevron" size={17} />
        <span className="expandable-title">
          <strong>{todo.title}</strong>
          <span>{todo.area}</span>
        </span>
        <span className="expandable-meta">
          <StatusBadge status={todo.status} />
          <SizeBadge size={todo.size} />
          <span>{todo.owner}</span>
          <DueDate todo={todo} />
        </span>
      </summary>
      <div className="expandable-body">
        <DescriptionButton todo={todo} onOpenDetails={onOpenDetails} variant="row" />
        {todo.blockers && (
          <div className="blocker-note row-blocker">
            <AlertTriangle size={16} />
            <span>{todo.blockers}</span>
          </div>
        )}
        <div className="row-metadata">
          <span>Created {formatDate(todo.createdAt.slice(0, 10))}</span>
          <span>Updated {formatDate(todo.updatedAt.slice(0, 10))}</span>
        </div>
        <div className="expandable-actions">
          {todo.status === 'done' ? (
            <button type="button" className="row-action" onClick={() => onStatusChange(todo.id, 'todo')}>
              <RotateCcw size={16} />
              Reopen
            </button>
          ) : (
            <button type="button" className="row-action" onClick={() => onStatusChange(todo.id, 'done')}>
              <Check size={16} />
              Mark Done
            </button>
          )}
          <button type="button" className="row-action" onClick={() => onEdit(todo)}>
            <Edit3 size={16} />
            Edit
          </button>
          <button type="button" className="row-action danger" onClick={() => onDelete(todo.id)}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      </div>
    </details>
  );
}

function DescriptionButton({
  todo,
  onOpenDetails,
  variant,
}: {
  todo: TodoItem;
  onOpenDetails: (todo: TodoItem) => void;
  variant: 'card' | 'table' | 'row';
}) {
  const description = todo.description.trim();

  return (
    <button
      type="button"
      className={`description-trigger description-trigger-${variant}${description ? '' : ' is-empty'}`}
      onClick={() => onOpenDetails(todo)}
      aria-label={`Open details for ${todo.title}`}
      title="Open details"
    >
      {description || 'No description'}
    </button>
  );
}

function TodoDetailsDialog({
  todo,
  onClose,
  onEdit,
  onDelete,
  onStatusChange,
}: {
  todo: TodoItem;
  onClose: () => void;
  onEdit: (todo: TodoItem) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: Status) => void;
}) {
  function deleteAndClose() {
    onDelete(todo.id);
    onClose();
  }

  return (
    <div className="details-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-details-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="details-header">
          <div>
            <span className="eyebrow">{todo.area}</span>
            <h2 id="todo-details-title">{todo.title}</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close details" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="details-badges">
          <PriorityBadge priority={todo.priority} />
          <SizeBadge size={todo.size} />
          <StatusBadge status={todo.status} />
          <span>{todo.owner}</span>
          <DueDate todo={todo} />
        </div>

        <section className="details-section">
          <h3>Description</h3>
          <p className={todo.description.trim() ? '' : 'muted'}>{todo.description.trim() || 'No description yet.'}</p>
        </section>

        {todo.blockers && (
          <section className="details-section">
            <h3>Blockers</h3>
            <div className="blocker-note details-blocker">
              <AlertTriangle size={16} />
              <span>{todo.blockers}</span>
            </div>
          </section>
        )}

        <div className="details-metadata">
          <span>Created {formatDate(todo.createdAt.slice(0, 10))}</span>
          <span>Updated {formatDate(todo.updatedAt.slice(0, 10))}</span>
        </div>

        <div className="details-actions">
          {todo.status === 'done' ? (
            <button type="button" className="row-action" onClick={() => onStatusChange(todo.id, 'todo')}>
              <RotateCcw size={16} />
              Reopen
            </button>
          ) : (
            <button type="button" className="row-action" onClick={() => onStatusChange(todo.id, 'done')}>
              <Check size={16} />
              Mark Done
            </button>
          )}
          <button type="button" className="row-action" onClick={() => onEdit(todo)}>
            <Edit3 size={16} />
            Edit
          </button>
          <button type="button" className="row-action danger" onClick={deleteAndClose}>
            <Trash2 size={16} />
            Delete
          </button>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metric metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`priority-badge priority-${priority.toLowerCase()}`}>
      {priorityMeta[priority].short} {priorityMeta[priority].label}
    </span>
  );
}

function SizeBadge({ size }: { size: Size }) {
  return (
    <span className={`size-badge size-${size.toLowerCase()}`}>
      {size} {sizeMeta[size].label}
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const column = statusColumns.find(item => item.id === status);
  return <span className={`status-badge status-${status}`}>{column?.title ?? status}</span>;
}

function DueDate({ todo }: { todo: TodoItem }) {
  const state = dueState(todo);
  return <span className={`due-date due-${state}`}>{formatDate(todo.todoDate)}</span>;
}

function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="empty-state">
      <Archive size={26} />
      <h2>No matching todos</h2>
      <button type="button" className="secondary-action" onClick={onReset}>
        Clear Search
      </button>
    </div>
  );
}

function normalizeDraft(draft: TodoDraft): TodoDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    description: draft.description.trim(),
    blockers: draft.blockers.trim(),
    area: draft.area.trim() || 'Product',
    todoDate: draft.todoDate || toDateInputValue(new Date()),
  };
}

function dueState(todo: TodoItem): 'none' | 'future' | 'today' | 'overdue' | 'done' {
  if (isClosedStatus(todo.status)) return 'done';
  if (!todo.todoDate) return 'none';

  const today = startOfDay(new Date()).getTime();
  const due = startOfDay(new Date(`${todo.todoDate}T00:00:00`)).getTime();

  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'future';
}

function isClosedStatus(status: Status) {
  return status === 'done';
}

function compareTodosForDrawer(a: TodoItem, b: TodoItem) {
  const closedDifference = Number(isClosedStatus(a.status)) - Number(isClosedStatus(b.status));
  if (closedDifference !== 0) return closedDifference;

  const statusDifference = statusColumns.findIndex(status => status.id === a.status) - statusColumns.findIndex(status => status.id === b.status);
  if (statusDifference !== 0) return statusDifference;

  const dateDifference = new Date(`${a.todoDate}T00:00:00`).getTime() - new Date(`${b.todoDate}T00:00:00`).getTime();
  if (dateDifference !== 0) return dateDifference;

  return a.title.localeCompare(b.title);
}

function formatDate(value: string) {
  if (!value) return 'No date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${value}T00:00:00`));
}

function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function createId() {
  return crypto.randomUUID?.() ?? `todo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadTodos(): TodoItem[] {
  try {
    const seeds = seedTodos();
    const seedIds = new Set(seeds.map(todo => todo.id));
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyRaw = LEGACY_STORAGE_KEYS.map(key => localStorage.getItem(key)).find(Boolean);
      if (!legacyRaw) return seedTodos();

      const legacyParsed = JSON.parse(legacyRaw);
      if (!Array.isArray(legacyParsed)) return seedTodos();

      const customLegacyTodos = legacyParsed
        .map(coerceTodoItem)
        .filter((todo): todo is TodoItem => Boolean(todo))
        .filter(todo => !legacySeedIds.has(todo.id) && !seedIds.has(todo.id));

      return [...seeds, ...customLegacyTodos];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return seedTodos();
    const validTodos = parsed.map(coerceTodoItem).filter((todo): todo is TodoItem => Boolean(todo));
    return validTodos.length > 0 ? validTodos : seedTodos();
  } catch {
    return seedTodos();
  }
}

function coerceTodoItem(value: unknown): TodoItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<TodoItem>;
  if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;

  const priority = priorityOrder.includes(item.priority as Priority) ? (item.priority as Priority) : 'P2';
  const area = typeof item.area === 'string' && item.area.trim() ? item.area.trim() : 'Product';

  return {
    id: item.id,
    title: item.title,
    description: typeof item.description === 'string' ? item.description : '',
    priority,
    todoDate: typeof item.todoDate === 'string' && item.todoDate ? item.todoDate : toDateInputValue(new Date()),
    blockers: typeof item.blockers === 'string' ? item.blockers : '',
    status: coerceStatus(item.status),
    owner: coerceOwner(item.owner, area),
    size: sizeOrder.includes(item.size as Size) ? (item.size as Size) : defaultSizeForPriority(priority),
    area,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
  };
}

function coerceStatus(value: unknown): Status {
  if (value === 'outdated') return 'done';
  return statusColumns.some(status => status.id === value) ? (value as Status) : 'todo';
}

function coerceOwner(value: unknown, area: string): Owner {
  if (typeof value === 'string') {
    const exactOwner = ownerOptions.find(owner => owner.toLowerCase() === value.toLowerCase());
    if (exactOwner) return exactOwner;
  }

  if (['Product', 'Growth', 'Website'].includes(area)) return 'Nick';
  if (area === 'QA') return 'Facundo';
  if (['Compliance', 'Ops', 'Docs'].includes(area)) return 'Santiago';
  return 'David';
}

function defaultSizeForPriority(priority: Priority): Size {
  if (priority === 'P0') return 'L';
  if (priority === 'P1') return 'M';
  if (priority === 'P2') return 'S';
  return 'XS';
}

type SeedTodo = Pick<TodoItem, 'id' | 'title' | 'description' | 'priority' | 'blockers' | 'status' | 'owner' | 'size' | 'area'> & {
  dueIn: number;
};

function seedTodos(): TodoItem[] {
  const now = new Date().toISOString();
  const seeds: SeedTodo[] = [
    {
      id: 'docs-engineering-api-calls-active-count',
      title: '/api/calls returns hardcoded active-call data',
      description: 'Proxy active-call count from Pipecat or remove the Node stub so admin and observability do not show silently wrong call counts. Source: docs/ENGINEERING_BACKLOG.md.',
      priority: 'P0',
      dueIn: 1,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'M',
      area: 'Admin',
    },
    {
      id: 'docs-pilot-mobile-login-signup',
      title: 'Prove mobile login and sign-up',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/01_auth_sign_in.yaml verifies returning-user sign-in to the dashboard, apps/mobile/.maestro/manual/auth_create_account.yaml covers create-account setup, apps/mobile/.maestro/flows/11_sign_out.yaml verifies sign-out, and tests/integration/mobile-auth-routing.test.js covers no-profile and profile-error recovery. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 1,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'L',
      area: 'Mobile',
    },
    {
      id: 'docs-pilot-mobile-onboarding',
      title: 'Prove the mobile onboarding path',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/10_onboarding_full.yaml creates a fresh account, completes onboarding through dashboard, routes/onboarding.js validates duplicate/same-phone cases and creates senior/caregiver/reminder rows in a transaction, and tests/integration/routes/onboarding.test.js covers the transaction and phone-reuse protections. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 2,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'L',
      area: 'Mobile',
    },
    {
      id: 'docs-pilot-reminder-crud',
      title: 'Prove mobile reminder CRUD works end to end',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/04_reminders_tab.yaml verifies add, edit, native time picker, save, and delete for reminders, and apps/mobile/app/(tabs)/reminders.tsx refreshes the reminders query on tab focus for out-of-band voice-created reminders. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 3,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'M',
      area: 'Mobile',
    },
    {
      id: 'docs-pilot-reminder-delivery-dev-call',
      title: 'Prove reminder delivery works in a dev call',
      description: 'A reminder created through the app/API is picked up by the Node scheduler, mentioned in a dev Telnyx call, and marked delivered. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 4,
      blockers: 'Needs a dummy or consenting dev Telnyx call.',
      status: 'blocked',
      owner: 'David',
      size: 'L',
      area: 'Voice',
    },
    {
      id: 'docs-pilot-mobile-schedule-controls',
      title: 'Prove mobile schedule and call controls',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/03_schedule_tab.yaml verifies week navigation plus add/edit/delete scheduled calls, apps/mobile/.maestro/manual/instant_call.yaml covers the live instant-call path, and tests/integration/mobile-instant-call.test.js pins stable selectors and safe error rendering. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 5,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'M',
      area: 'Mobile',
    },
    {
      id: 'docs-pilot-manual-call-pipecat',
      title: 'Prove manual call initiation reaches Pipecat',
      description: 'Node /api/call asks Pipecat /telnyx/outbound to create a Telnyx call, then /ws starts with expected context and masked logs. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 5,
      blockers: 'Needs dev deploy and a dummy or consenting test call.',
      status: 'blocked',
      owner: 'David',
      size: 'M',
      area: 'Voice',
    },
    {
      id: 'docs-pilot-inbound-known-onboarding',
      title: 'Prove inbound known-senior and onboarding voice calls',
      description: 'Known senior inbound calls load profile context, while unknown callers use onboarding flow and prospect handling without senior reminders. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 6,
      blockers: 'Needs one known test number and one unrecognized test number.',
      status: 'blocked',
      owner: 'David',
      size: 'M',
      area: 'Voice',
    },
    {
      id: 'docs-pilot-post-call-observability',
      title: 'Prove post-call analysis, memory, and observability',
      description: 'A completed dev call writes conversation, analysis, memory, daily context, metrics, and snapshot; observability renders without raw PHI in logs. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 7,
      blockers: 'Needs completed dummy or consenting dev call.',
      status: 'blocked',
      owner: 'David',
      size: 'L',
      area: 'Observability',
    },
    {
      id: 'docs-pilot-mobile-no-crash-pass',
      title: 'Run a mobile no-crash pass',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/00_full_clickthrough.yaml covers sign-in, dashboard, schedule, reminders, settings, loved-one profile, caregiver profile, notification preferences, help, and the sign-out confirmation path. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 8,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'M',
      area: 'QA',
    },
    {
      id: 'docs-pilot-sensitive-debug-logs',
      title: 'Keep sensitive debug logs out',
      description: 'Logs should not print raw onboarding payloads, phone numbers, push tokens, transcripts, memory queries, or web-search queries. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P0',
      dueIn: 8,
      blockers: '',
      status: 'todo',
      owner: 'Santiago',
      size: 'M',
      area: 'Compliance',
    },
    {
      id: 'docs-engineering-orchestration-files',
      title: 'Extract largest orchestration files',
      description: 'Split telnyx.py signature/event parsing from outbound orchestration, and move scheduler dual-path queue branches into stable modules. Source: docs/ENGINEERING_BACKLOG.md.',
      priority: 'P1',
      dueIn: 10,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'L',
      area: 'Infrastructure',
    },
    {
      id: 'docs-engineering-mobile-screens',
      title: 'Extract largest mobile screens',
      description: 'Extract screen-specific hooks and field components, starting with schedule.tsx and sign-in.tsx. Source: docs/ENGINEERING_BACKLOG.md.',
      priority: 'P1',
      dueIn: 11,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'M',
      area: 'Mobile',
    },
    {
      id: 'docs-engineering-load-tests-telnyx',
      title: 'Update load tests from Twilio to Telnyx',
      description: 'Replace mock Twilio media-stream protocol with Telnyx WebSocket event shapes and L16/16k audio assumptions. Source: docs/ENGINEERING_BACKLOG.md.',
      priority: 'P1',
      dueIn: 12,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'M',
      area: 'Voice',
    },
    {
      id: 'docs-engineering-node-python-parity',
      title: 'Add Node/Python parity contract tests',
      description: 'Assert encrypted field wire format, retention behavior, audit event shape, and token revocation semantics stay aligned. Source: docs/ENGINEERING_BACKLOG.md.',
      priority: 'P1',
      dueIn: 13,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'L',
      area: 'Compliance',
    },
    {
      id: 'docs-pilot-maestro-flows-reliable',
      title: 'Make mobile Maestro flows reliable before every pilot build',
      description: 'Flows should assert visible user outcomes and avoid unnecessary sleeps or brittle selectors. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P1',
      dueIn: 14,
      blockers: '',
      status: 'todo',
      owner: 'Facundo',
      size: 'M',
      area: 'QA',
    },
    {
      id: 'docs-pilot-api-coverage-reminders-schedules',
      title: 'Add focused API coverage for reminders and schedules',
      description: 'Done on review 2026-05-25: reminder route coverage exists in tests/integration/api/routes.test.js and core route runtime tests; schedule authorization/timezone coverage exists in tests/integration/routes/schedule-auth.test.js and tests/integration/services/scheduler-timezone.test.js. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P1',
      dueIn: 14,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'M',
      area: 'Infrastructure',
    },
    {
      id: 'docs-pilot-store-links',
      title: 'Replace placeholder store links on the public website',
      description: 'Done on review 2026-05-25: the App Store action opens the waitlist modal with a SOON badge, and the web action points to /signup. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P1',
      dueIn: 15,
      blockers: '',
      status: 'done',
      owner: 'Nick',
      size: 'S',
      area: 'Website',
    },
    {
      id: 'docs-pilot-consumer-faq-semantic-selectors',
      title: 'Make consumer FAQ Playwright test use semantic selectors',
      description: 'Done on review 2026-05-25: tests/e2e/consumer/landing.spec.ts uses getByRole for the FAQ button and asserts answer content appears. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P1',
      dueIn: 16,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'S',
      area: 'Website',
    },
    {
      id: 'docs-pilot-admin-e2e-fixed-sleeps',
      title: 'Replace fixed sleeps in admin E2E tests',
      description: 'Replace waitForTimeout with deterministic success, list, or API assertions. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P1',
      dueIn: 16,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'S',
      area: 'Admin',
    },
    {
      id: 'docs-bug-001-signup-password-check',
      title: 'BUG-001 signup password check',
      description: 'Done on review 2026-05-25: the archived BUG-001 entry is marked fixed, and apps/mobile/manual auth_create_account.yaml covers strong-password and own-password paths. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 17,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'S',
      area: 'QA',
    },
    {
      id: 'docs-bug-002-full-onboarding-completion',
      title: 'BUG-002 full onboarding completion',
      description: 'Done/archived on review 2026-05-25: the archived BUG-002 entry says the original bug was fixed. A newer similar GitHub issue, #172 BUG-004, remains open and should be tracked separately. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 17,
      blockers: 'Current similar behavior belongs in GitHub issue #172, not this archived QA note.',
      status: 'done',
      owner: 'Facundo',
      size: 'M',
      area: 'QA',
    },
    {
      id: 'docs-bug-013-abandoned-setup-cleanup',
      title: 'BUG-013 abandoned setup cleanup',
      description: 'Done on review 2026-05-25: incomplete-account cleanup route/tests exist, and apps/mobile/.maestro/flows/12_incomplete_account_cleanup.yaml covers the abandoned setup path. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 18,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'S',
      area: 'QA',
    },
    {
      id: 'docs-bug-013-leave-setup-cleanup',
      title: 'BUG-013 leave setup cleanup',
      description: 'Done on review 2026-05-25: apps/mobile/.maestro/flows/13_leave_setup_cleanup.yaml covers the leave-setup path and the route refuses cleanup after a Donna profile exists. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 18,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'S',
      area: 'QA',
    },
    {
      id: 'docs-bug-recurring-schedule-validation',
      title: 'Recurring schedule validation',
      description: 'Done on review 2026-05-25: onboarding step 5 validates recurring schedules before progress, and validators/schemas.js rejects recurring schedules without selected days. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 19,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'S',
      area: 'QA',
    },
    {
      id: 'docs-bug-duplicate-loved-one-phone-recovery',
      title: 'Duplicate loved-one phone recovery',
      description: 'Done on review 2026-05-25: /api/onboarding/validate-phone returns senior_phone_taken, the mobile API maps duplicate-phone errors, and GitHub issue #180 is closed completed. Source: docs/plans/archive/BUG_TRACKER.md.',
      priority: 'P1',
      dueIn: 19,
      blockers: '',
      status: 'done',
      owner: 'Facundo',
      size: 'S',
      area: 'QA',
    },
    {
      id: 'docs-feature-ask-donna-mobile',
      title: 'Dynamic reminder creation and call scheduling',
      description: 'Port and improve Ask Donna chat into the mobile app, including smoother bulk reminder and call scheduling. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P2',
      dueIn: 22,
      blockers: 'Timezone handling needs to be reliable first.',
      status: 'todo',
      owner: 'Nick',
      size: 'XL',
      area: 'Product',
    },
    {
      id: 'docs-feature-timezone-management',
      title: 'Timezone management audit and fixes',
      description: 'Ensure scheduled calls use the senior timezone by default across onboarding, scheduling, Ask Donna, and display layers. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P2',
      dueIn: 23,
      blockers: '',
      status: 'todo',
      owner: 'David',
      size: 'L',
      area: 'Infrastructure',
    },
    {
      id: 'docs-feature-per-person-alert-tuning',
      title: 'Fine-tune alerts per person',
      description: 'Add per-person alert preference controls so caregivers can tune alert channels, cadence, quiet hours, urgency thresholds, and escalation/skip behavior by senior or relationship instead of relying on one global setting. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P2',
      dueIn: 24,
      blockers: 'Needs notification channel and escalation policy scoping.',
      status: 'todo',
      owner: 'Nick',
      size: 'M',
      area: 'Product',
    },
    {
      id: 'docs-feature-direct-data-feeds',
      title: 'Direct data feeds for factual queries',
      description: 'Research and implement structured feeds for sports, weather, and other definitive real-time answers where web search is unreliable. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P2',
      dueIn: 25,
      blockers: 'Needs query-category research from real usage.',
      status: 'todo',
      owner: 'Nick',
      size: 'L',
      area: 'Voice',
    },
    {
      id: 'docs-pilot-onboarding-docs-checklist',
      title: 'Add a first-pilot checklist to onboarding docs',
      description: 'Done on review 2026-05-25: docs/ONBOARDING.md now includes mobile setup/onboarding validation commands, dev call workflow, and PHI handling reminders. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P2',
      dueIn: 28,
      blockers: '',
      status: 'done',
      owner: 'Santiago',
      size: 'S',
      area: 'Docs',
    },
    {
      id: 'docs-pilot-readme-directory-align',
      title: 'Keep root README and directory map aligned',
      description: 'Done on review 2026-05-25: README.md and docs/README.md point to DIRECTORY.md, current architecture docs, the prototype pilot backlog, and historical-plan guidance. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P2',
      dueIn: 29,
      blockers: '',
      status: 'done',
      owner: 'Santiago',
      size: 'S',
      area: 'Docs',
    },
    {
      id: 'docs-pilot-observability-navigation-assertion',
      title: 'Add deterministic observability navigation assertion',
      description: 'Done on review 2026-05-25: tests/e2e/observability/navigation.spec.ts and history.spec.ts assert expected panels/headings during navigation. Source: docs/plans/PROTOTYPE_PILOT_BACKLOG.md.',
      priority: 'P2',
      dueIn: 30,
      blockers: '',
      status: 'done',
      owner: 'David',
      size: 'S',
      area: 'Observability',
    },
    {
      id: 'docs-feature-admin-dashboard-revamp',
      title: 'Admin dashboard revamp',
      description: 'Scope a revamp that surfaces per-user call rates, duration, reminder usage, topics, and engagement trends. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P3',
      dueIn: 35,
      blockers: 'Needs a Nick/David scoping discussion before build work.',
      status: 'todo',
      owner: 'Nick',
      size: 'L',
      area: 'Admin',
    },
    {
      id: 'docs-feature-agentic-workflows',
      title: 'Agentic workflows for seniors',
      description: 'Explore phone-based action-taking services such as ordering, party planning, and ride scheduling after stronger demand signals. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P3',
      dueIn: 42,
      blockers: 'Wait for significant user growth and clear demand.',
      status: 'todo',
      owner: 'Nick',
      size: 'XL',
      area: 'Product',
    },
    {
      id: 'docs-feature-donna-texts-seniors',
      title: 'Donna texts seniors',
      description: 'Build SMS/text interactions for reminders, timely updates, and lightweight senior engagement alongside phone calls. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P3',
      dueIn: 43,
      blockers: 'Depends on evidence that seniors want this channel.',
      status: 'todo',
      owner: 'Nick',
      size: 'L',
      area: 'Product',
    },
    {
      id: 'docs-feature-brain-games',
      title: 'Brain games',
      description: 'Add trivia, 20 questions, word association, and other cognitive games that work naturally over calls. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P3',
      dueIn: 44,
      blockers: '',
      status: 'todo',
      owner: 'Nick',
      size: 'M',
      area: 'Voice',
    },
    {
      id: 'docs-feature-family-mapping',
      title: 'Family mapping',
      description: 'Let caregivers list relevant people in a senior life so Donna can reference relationships, roles, and stories during calls. Source: docs/FEATURE_BACKLOG.md.',
      priority: 'P3',
      dueIn: 45,
      blockers: 'Needs purpose and implementation scope.',
      status: 'todo',
      owner: 'Nick',
      size: 'L',
      area: 'Product',
    },
  ];

  return seeds.map(seed => ({
    id: seed.id,
    title: seed.title,
    description: seed.description,
    priority: seed.priority,
    todoDate: addDays(seed.dueIn),
    blockers: seed.blockers,
    status: seed.status,
    owner: seed.owner,
    size: seed.size,
    area: seed.area,
    createdAt: now,
    updatedAt: now,
  }));
}

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

export default App;
