const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { OAuth2Client } = require('google-auth-library');
const Database = require('better-sqlite3');

// ==================== Configuration ====================
const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const app = express();
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ==================== Database Setup ====================
const db = new Database('homework.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    picture TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    due_date TEXT NOT NULL,
    description TEXT,
    completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_user_id ON assignments(user_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_due_date ON assignments(due_date);
`);

// Prepared statements for better performance
const statements = {
  upsertUser: db.prepare(`
    INSERT INTO users (id, email, name, picture, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      picture = excluded.picture,
      updated_at = CURRENT_TIMESTAMP
  `),

  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),

  getAssignments: db.prepare('SELECT * FROM assignments WHERE user_id = ? ORDER BY due_date ASC'),

  getAssignment: db.prepare('SELECT * FROM assignments WHERE id = ? AND user_id = ?'),

  insertAssignment: db.prepare(`
    INSERT INTO assignments (id, user_id, title, subject, type, due_date, description, completed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  updateAssignment: db.prepare(`
    UPDATE assignments
    SET title = ?, subject = ?, type = ?, due_date = ?, description = ?, completed = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `),

  deleteAssignment: db.prepare('DELETE FROM assignments WHERE id = ? AND user_id = ?'),

  deleteAllAssignments: db.prepare('DELETE FROM assignments WHERE user_id = ?'),

  bulkInsertAssignment: db.prepare(`
    INSERT OR REPLACE INTO assignments (id, user_id, title, subject, type, due_date, description, completed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
};

// ==================== Middleware ====================
app.use(cors());
app.use(express.json());

// Serve static files (the HTML frontend)
app.use(express.static(path.join(__dirname)));

// ==================== Auth Middleware ====================
async function verifyGoogleToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };

    // Upsert user in database
    statements.upsertUser.run(req.user.id, req.user.email, req.user.name, req.user.picture);

    next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== API Routes ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get current user info
app.get('/api/me', verifyGoogleToken, (req, res) => {
  const user = statements.getUser.get(req.user.id);
  res.json(user);
});

// Get all assignments for user
app.get('/api/assignments', verifyGoogleToken, (req, res) => {
  try {
    const assignments = statements.getAssignments.all(req.user.id);
    res.json(assignments.map(formatAssignment));
  } catch (error) {
    console.error('Error fetching assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// Create new assignment
app.post('/api/assignments', verifyGoogleToken, (req, res) => {
  try {
    const { id, title, subject, type, dueDate, description, completed } = req.body;

    if (!title || !subject || !type || !dueDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const assignmentId = id || Date.now().toString();

    statements.insertAssignment.run(
      assignmentId,
      req.user.id,
      title,
      subject,
      type,
      dueDate,
      description || null,
      completed ? 1 : 0
    );

    const assignment = statements.getAssignment.get(assignmentId, req.user.id);
    res.status(201).json(formatAssignment(assignment));
  } catch (error) {
    console.error('Error creating assignment:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
});

// Update assignment
app.put('/api/assignments/:id', verifyGoogleToken, (req, res) => {
  try {
    const { id } = req.params;
    const { title, subject, type, dueDate, description, completed } = req.body;

    const existing = statements.getAssignment.get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    statements.updateAssignment.run(
      title || existing.title,
      subject || existing.subject,
      type || existing.type,
      dueDate || existing.due_date,
      description !== undefined ? description : existing.description,
      completed !== undefined ? (completed ? 1 : 0) : existing.completed,
      id,
      req.user.id
    );

    const updated = statements.getAssignment.get(id, req.user.id);
    res.json(formatAssignment(updated));
  } catch (error) {
    console.error('Error updating assignment:', error);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// Delete assignment
app.delete('/api/assignments/:id', verifyGoogleToken, (req, res) => {
  try {
    const { id } = req.params;

    const existing = statements.getAssignment.get(id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    statements.deleteAssignment.run(id, req.user.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting assignment:', error);
    res.status(500).json({ error: 'Failed to delete assignment' });
  }
});

// Sync all assignments (bulk update)
app.post('/api/assignments/sync', verifyGoogleToken, (req, res) => {
  try {
    const { assignments } = req.body;

    if (!Array.isArray(assignments)) {
      return res.status(400).json({ error: 'Assignments must be an array' });
    }

    // Use a transaction for bulk operations
    const syncTransaction = db.transaction((userId, items) => {
      // Delete all existing assignments for user
      statements.deleteAllAssignments.run(userId);

      // Insert all new assignments
      for (const a of items) {
        statements.bulkInsertAssignment.run(
          a.id || Date.now().toString() + Math.random().toString(36).substr(2, 9),
          userId,
          a.title,
          a.subject,
          a.type,
          a.dueDate,
          a.description || null,
          a.completed ? 1 : 0,
          a.createdAt || new Date().toISOString()
        );
      }
    });

    syncTransaction(req.user.id, assignments);

    const updated = statements.getAssignments.all(req.user.id);
    res.json(updated.map(formatAssignment));
  } catch (error) {
    console.error('Error syncing assignments:', error);
    res.status(500).json({ error: 'Failed to sync assignments' });
  }
});

// ==================== Helper Functions ====================
function formatAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    type: row.type,
    dueDate: row.due_date,
    description: row.description,
    completed: row.completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           Homework Calendar Backend Started!               ║
╠════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                  ║
║  API endpoints:                                            ║
║    GET    /api/health          - Health check              ║
║    GET    /api/me              - Get current user          ║
║    GET    /api/assignments     - List all assignments      ║
║    POST   /api/assignments     - Create assignment         ║
║    PUT    /api/assignments/:id - Update assignment         ║
║    DELETE /api/assignments/:id - Delete assignment         ║
║    POST   /api/assignments/sync - Bulk sync assignments    ║
╚════════════════════════════════════════════════════════════╝
  `);

  if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠️  WARNING: GOOGLE_CLIENT_ID not set in .env file');
    console.warn('   Google Sign-In will not work without it.\n');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});
