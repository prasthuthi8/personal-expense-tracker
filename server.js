const express    = require('express')
const mysql      = require('mysql2')
const cors       = require('cors')
const jwt        = require('jsonwebtoken')
const bcrypt     = require('bcryptjs')

const app    = express()
const SECRET = 'cashlens_secret_key_2025'

app.use(cors())
app.use(express.json())

// ── Database ──────────────────────────────────────────────────
const db = mysql.createConnection({
  host:     'localhost',
  user:     'root',
  password: 'root',   // ← your MySQL password
  database: 'personal_expense_tracker'
})

db.connect(err => {
  if (err) { console.error('❌ DB Error:', err.message); process.exit(1) }
  console.log('✅ Connected to MySQL')
  db.query("SET NAMES 'utf8mb4'")

  // Create users table if not exists
  db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      name       VARCHAR(100) NOT NULL,
      email      VARCHAR(150) UNIQUE,
      phone      VARCHAR(15)  UNIQUE,
      password   VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Add user_id column to expenses if not exists
  db.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS user_id INT,
    ADD CONSTRAINT fk_user
      FOREIGN KEY (user_id) REFERENCES users(id)
      ON DELETE CASCADE
  `, err => {
    if (err && !err.message.includes('Duplicate')) {
      console.log('Column may already exist — continuing')
    }
  })
})

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token' })
  try {
    req.user = jwt.verify(token, SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── REGISTER ──────────────────────────────────────────────────
app.post('/auth/register', async (req, res) => {
  const { name, email, phone, password } = req.body
  if (!name || !password)
    return res.status(400).json({ error: 'Name and password required' })
  if (!email && !phone)
    return res.status(400).json({ error: 'Email or phone required' })

  try {
    const hashed = await bcrypt.hash(password, 10)
    const sql = `
      INSERT INTO users (name, email, phone, password)
      VALUES (?, ?, ?, ?)
    `
    db.query(sql, [name, email||null, phone||null, hashed], (err, result) => {
      if (err) {
        if (err.code === 'ER_DUP_ENTRY')
          return res.status(400).json({ error: 'Email or phone already registered' })
        return res.status(500).json({ error: err.message })
      }
      const token = jwt.sign(
        { id: result.insertId, name, email, phone },
        SECRET,
        { expiresIn: '7d' }
      )
      res.json({ message: 'Registered!', token, name })
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── LOGIN ─────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { identifier, password } = req.body
  if (!identifier || !password)
    return res.status(400).json({ error: 'All fields required' })

  const sql = `
    SELECT * FROM users
    WHERE email = ? OR phone = ?
    LIMIT 1
  `
  db.query(sql, [identifier, identifier], async (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    if (!results.length)
      return res.status(401).json({ error: 'No account found with this email or phone' })

    const user  = results[0]
    const match = await bcrypt.compare(password, user.password)
    if (!match)
      return res.status(401).json({ error: 'Incorrect password' })

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, phone: user.phone },
      SECRET,
      { expiresIn: '7d' }
    )
    res.json({ message: 'Login successful!', token, name: user.name })
  })
})

// ── CATEGORIES ────────────────────────────────────────────────
app.get('/categories', auth, (req, res) => {
  db.query('SELECT * FROM categories ORDER BY label', (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})

// ── EXPENSES ──────────────────────────────────────────────────
app.get('/expenses', auth, (req, res) => {
  let sql = `
    SELECT
      e.id, e.name, e.amount,
      e.category_code, e.is_needed, e.note,
      DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
      e.created_at,
      c.label AS category_label,
      c.emoji AS category_emoji,
      c.color AS category_color
    FROM expenses e
    JOIN categories c ON e.category_code = c.code
    WHERE e.user_id = ?
  `
  const params = [req.user.id]
  if (req.query.month) {
    sql += ' AND DATE_FORMAT(e.expense_date, "%Y-%m") = ?'
    params.push(req.query.month)
  }
  sql += ' ORDER BY e.expense_date DESC, e.created_at DESC'

  db.query(sql, params, (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})

app.post('/expenses', auth, (req, res) => {
  const { name, amount, category_code, is_needed, note, expense_date } = req.body
  if (!name || !amount || !category_code || !is_needed || !expense_date)
    return res.status(400).json({ error: 'All fields except note are required' })
  if (amount <= 0)
    return res.status(400).json({ error: 'Amount must be greater than 0' })

  const month = expense_date.slice(0, 7)
  const sql   = `
    INSERT INTO expenses
      (name, amount, category_code, is_needed, note, expense_date, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  db.query(sql,
    [name, amount, category_code, is_needed, note||'', expense_date, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })

      // Check budget
      const checkSql = `
        SELECT
          COALESCE(ms.total_amount, 0) AS total_spent,
          COALESCE(b.monthly_limit, 0) AS budget_limit
        FROM (SELECT 1) d
        LEFT JOIN monthly_summary ms ON ms.month_year = ?
        LEFT JOIN budget b ON b.month_year = ? AND b.user_id = ?
      `
      db.query(checkSql, [month, month, req.user.id], (err2, rows) => {
        if (err2) return res.json({ message: 'Expense added!', id: result.insertId, budgetStatus: null })

        const totalSpent  = parseFloat(rows[0].total_spent)  || 0
        const budgetLimit = parseFloat(rows[0].budget_limit) || 0

        if (budgetLimit === 0)
          return res.json({ message: 'Expense added!', id: result.insertId, budgetStatus: 'no_budget' })

        const pct        = Math.round((totalSpent / budgetLimit) * 100)
        const exceededBy = totalSpent - budgetLimit

        if (totalSpent > budgetLimit) {
          const alertSql = `
            INSERT INTO budget_alerts
              (month_year, expense_name, expense_amount, total_after, budget_limit, exceeded_by)
            VALUES (?, ?, ?, ?, ?, ?)
          `
          db.query(alertSql,
            [month, name, amount, totalSpent, budgetLimit, exceededBy], () => {})
          return res.json({
            message: 'Expense added!', id: result.insertId,
            budgetStatus: 'exceeded', totalSpent, budgetLimit,
            exceededBy, pctUsed: pct, expenseName: name, expenseAmount: amount
          })
        }

        if (pct >= 80)
          return res.json({
            message: 'Expense added!', id: result.insertId,
            budgetStatus: 'warning', totalSpent, budgetLimit,
            pctUsed: pct, remaining: budgetLimit - totalSpent
          })

        res.json({
          message: 'Expense added!', id: result.insertId,
          budgetStatus: 'ok', totalSpent, budgetLimit, pctUsed: pct
        })
      })
    }
  )
})

app.delete('/expenses/:id', auth, (req, res) => {
  db.query(
    'DELETE FROM expenses WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      if (result.affectedRows === 0)
        return res.status(404).json({ error: 'Expense not found' })
      res.json({ message: 'Expense deleted!' })
    }
  )
})

// ── BUDGET ────────────────────────────────────────────────────
app.get('/budget/:month', auth, (req, res) => {
  db.query(
    'SELECT * FROM budget WHERE month_year = ? AND user_id = ?',
    [req.params.month, req.user.id],
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(results[0] || null)
    }
  )
})

app.post('/budget', auth, (req, res) => {
  const { month_year, monthly_limit } = req.body
  if (!month_year || !monthly_limit || monthly_limit <= 0)
    return res.status(400).json({ error: 'Valid month and budget required' })

  const sql = `
    INSERT INTO budget (month_year, monthly_limit, user_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE monthly_limit = VALUES(monthly_limit)
  `
  db.query(sql, [month_year, monthly_limit, req.user.id], err => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ message: 'Budget saved!', month_year, monthly_limit })
  })
})

// ── SUMMARY ───────────────────────────────────────────────────
app.get('/summary', auth, (req, res) => {
  const sql = `
    SELECT ms.*,
      COALESCE(b.monthly_limit, 0) AS budget_limit,
      CASE
        WHEN b.monthly_limit IS NULL OR b.monthly_limit = 0 THEN NULL
        ELSE ROUND((ms.total_amount / b.monthly_limit) * 100, 1)
      END AS pct_used
    FROM monthly_summary ms
    LEFT JOIN budget b
      ON ms.month_year = b.month_year
      AND b.user_id = ?
    WHERE ms.user_id = ?
    ORDER BY ms.month_year DESC
    LIMIT 12
  `
  db.query(sql, [req.user.id, req.user.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})

// ── WASTE ─────────────────────────────────────────────────────
app.get('/waste', auth, (req, res) => {
  const sql = `
    SELECT e.id, e.name, e.amount, e.is_needed, e.note,
      DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
      c.label AS category_label, c.emoji AS category_emoji,
      (e.amount * 12) AS yearly_projection
    FROM expenses e
    JOIN categories c ON e.category_code = c.code
    WHERE e.is_needed IN ('no','maybe')
    AND e.user_id = ?
    ORDER BY e.amount DESC
  `
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})

// ── AUDIT ─────────────────────────────────────────────────────
app.get('/audit', auth, (req, res) => {
  db.query(
    'SELECT * FROM expense_audit_log ORDER BY action_time DESC LIMIT 50',
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(results)
    }
  )
})

// ── START ─────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000')
})