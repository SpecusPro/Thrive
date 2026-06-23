const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'thrive-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireParent(req, res, next) {
  if (!req.session.userId || req.session.role !== 'parent') {
    return res.redirect('/login');
  }
  next();
}

// Routes
app.get('/', (req, res) => {
  if (req.session.userId) {
    if (req.session.role === 'parent') return res.redirect('/parent');
    return res.redirect('/app');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', async (req, res) => {
  const { email, password, role, displayName } = req.body;
  
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (!['parent', 'daughter'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  
  // If a parent is creating a child account, displayName is required
  if (role === 'daughter' && req.session?.role === 'parent' && !displayName) {
    return res.status(400).json({ error: 'Display name is required when creating a child account' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    
    const result = await pool.query(
      'INSERT INTO users (email, password, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, hashedPassword, role]
    );
    
    const user = result.rows[0];
    
    // If parent registers a child, create the link
    if (role === 'daughter' && req.session.userId && req.session.role === 'parent' && displayName) {
      await pool.query(
        'INSERT INTO children (parent_id, child_id, display_name) VALUES ($1, $2, $3)',
        [req.session.userId, user.id, displayName]
      );
      // Do NOT switch the session to the child - keep parent logged in
      return res.json({ success: true, role: 'parent' });
    }
    
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.email = user.email;
    
    res.json({ success: true, role: user.role });
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.email = user.email;

    res.json({ success: true, role: user.role });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// Daughter app
app.get('/app', requireAuth, (req, res) => {
  if (req.session.role !== 'daughter') return res.redirect('/parent');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// API: Get tasks for current daughter (or parent viewing a child)
app.get('/api/tasks', requireAuth, async (req, res) => {
  let childId;
  
  if (req.query.child_id) {
    childId = parseInt(req.query.child_id);
    
    // Parent must own the child (check children table)
    if (req.session.role === 'parent') {
      const owns = await pool.query('SELECT 1 FROM children WHERE parent_id = $1 AND child_id = $2', [req.session.userId, childId]);
      if (owns.rows.length === 0) {
        console.log('Parent does not own child', req.session.userId, childId);
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (req.session.role !== 'daughter') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else {
    // No child_id provided - must be a daughter viewing their own tasks
    if (req.session.role !== 'daughter') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    childId = req.session.userId;
  }
  
  try {
    const result = await pool.query(
      `SELECT t.*, 
         EXISTS(SELECT 1 FROM task_completions WHERE task_id = t.id AND completed_date = CURRENT_DATE) as completed_today
       FROM tasks 
       WHERE child_id = $1 AND active = true 
       ORDER BY sort_order, created_at`,
      [childId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to load tasks:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

// API: Get children for parent
app.get('/api/children', requireParent, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.display_name, u.email 
       FROM children c 
       JOIN users u ON c.child_id = u.id 
       WHERE c.parent_id = $1`,
      [req.session.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Failed to load children:', err);
    res.status(500).json({ error: 'Failed to load children' });
  }
});

// API: Delete a child (parent only)
app.delete('/api/children/:id', requireParent, async (req, res) => {
  const childId = parseInt(req.params.id);
  
  try {
    // Verify ownership (also allow if the child link is missing but user is parent - for cleanup)
    const owns = await pool.query('SELECT 1 FROM children WHERE parent_id = $1 AND child_id = $2', [req.session.userId, childId]);
    if (owns.rows.length === 0) {
      // Check if the child even exists
      const childExists = await pool.query('SELECT 1 FROM users WHERE id = $1 AND role = $2', [childId, 'daughter']);
      if (childExists.rows.length === 0) {
        return res.status(404).json({ error: 'Child not found' });
      }
      // Allow parent to delete orphaned child for cleanup
      console.log('Allowing delete of orphaned child', childId);
    }
    
    // Delete in correct order to satisfy FK constraints
    await pool.query('DELETE FROM task_completions USING tasks WHERE task_completions.task_id = tasks.id AND tasks.child_id = $1', [childId]);
    await pool.query('DELETE FROM tasks WHERE child_id = $1', [childId]);
    await pool.query('DELETE FROM children WHERE child_id = $1', [childId]);
    await pool.query('DELETE FROM users WHERE id = $1', [childId]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete child:', err);
    res.status(500).json({ error: 'Failed to delete child' });
  }
});

// API: Delete task (parent only)
app.delete('/api/tasks/:id', requireParent, async (req, res) => {
  const taskId = parseInt(req.params.id);
  
  try {
    // Verify the task belongs to one of the parent's children
    const owns = await pool.query(
      `SELECT 1 FROM tasks t 
       JOIN children c ON t.child_id = c.child_id 
       WHERE t.id = $1 AND c.parent_id = $2`,
      [taskId, req.session.userId]
    );
    if (owns.rows.length === 0) return res.status(403).json({ error: 'Forbidden' });
    
    await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete task:', err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// API: Create task (parent only)
app.post('/api/tasks', requireParent, async (req, res) => {
  const { child_id, title, icon, frequency, interval_days } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO tasks (child_id, title, icon, frequency, interval_days) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [child_id, title, icon, frequency || 'daily', interval_days || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// API: Toggle task completion
app.post('/api/tasks/:id/toggle', requireAuth, async (req, res) => {
  if (req.session.role !== 'daughter') return res.status(403).json({ error: 'Forbidden' });
  
  const taskId = parseInt(req.params.id);
  
  try {
    // Verify task belongs to this user
    const taskCheck = await pool.query('SELECT id FROM tasks WHERE id = $1 AND child_id = $2', [taskId, req.session.userId]);
    if (taskCheck.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    
    const completed = await pool.query(
      `INSERT INTO task_completions (task_id, completed_date) 
       VALUES ($1, CURRENT_DATE) 
       ON CONFLICT (task_id, completed_date) DO NOTHING
       RETURNING id`,
      [taskId]
    );
    
    if (completed.rows.length === 0) {
      // Already completed, so un-complete it
      await pool.query('DELETE FROM task_completions WHERE task_id = $1 AND completed_date = CURRENT_DATE', [taskId]);
      res.json({ completed: false });
    } else {
      res.json({ completed: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle task' });
  }
});

// Parent dashboard
app.get('/parent', requireParent, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'parent.html'));
});

// Basic health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Thrive running on port ${PORT}`);
});