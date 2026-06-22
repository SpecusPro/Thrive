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

// Parent dashboard
app.get('/parent', requireParent, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'parent.html'));
});

// Basic health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Thrive running on port ${PORT}`);
});