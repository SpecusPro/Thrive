-- Thrive Database Schema
-- Parent creates and manages child profiles

-- Users table (both parents and daughters)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('parent', 'daughter')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Children table (links parent to daughter)
CREATE TABLE IF NOT EXISTS children (
    id SERIAL PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(parent_id, child_id)
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    child_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    icon TEXT,                    -- Font Awesome icon class, e.g. "fa-tooth"
    frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'periodic')),
    interval_days INTEGER,        -- Used when frequency = 'periodic' (e.g. 2 or 3)
    sort_order INTEGER DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Task completions
CREATE TABLE IF NOT EXISTS task_completions (
    id SERIAL PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    completed_date DATE NOT NULL DEFAULT CURRENT_DATE,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(task_id, completed_date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_child_id ON tasks(child_id);
CREATE INDEX IF NOT EXISTS idx_completions_task_id ON task_completions(task_id);
CREATE INDEX IF NOT EXISTS idx_completions_date ON task_completions(completed_date);