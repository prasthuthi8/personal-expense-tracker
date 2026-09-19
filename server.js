require('dotenv').config()
const express  = require('express')
const mysql    = require('mysql2')
const cors     = require('cors')
const jwt      = require('jsonwebtoken')
const bcrypt   = require('bcryptjs')
const nodemailer = require('nodemailer')

const app    = express()
const SECRET = process.env.JWT_SECRET || 'cashlens_secret_key_2025'

app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://cashlens-seven.vercel.app'
  ]
}))
app.use(express.json())


// ── Database connection ───────────────────────────────────────
const db = mysql.createConnection({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port:     process.env.DB_PORT || 3306
})

db.connect(err => {
  if (err) {
    console.error('❌ DB Error:', err.code, err.message)
    process.exit(1)
  }
  console.log('✅ Connected to MySQL — CashLens')
  db.query("SET NAMES 'utf8mb4'")
  // NOTE: All tables and triggers are created by database.sql
  // Do NOT create or alter tables here
})


// ── OTP store (in-memory for demo) ───────────────────────────
// In production this should use Redis or a DB table
const otpStore = {}

// ── Email transporter (Nodemailer + Gmail) ────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,  // your Gmail address
    pass: process.env.EMAIL_PASS   // your Gmail app password
  }
})


// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token provided' })
  try {
    req.user = jwt.verify(token, SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}


// ══════════════════════════════════════════════════════════════
//  OTP ROUTES
// ══════════════════════════════════════════════════════════════

// Send OTP to email
app.post('/auth/send-otp', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'Email is required' })

  // Generate random 4-digit OTP
  const otp     = Math.floor(1000 + Math.random() * 9000).toString()
  const expires = Date.now() + 10 * 60 * 1000  // expires in 10 minutes

  otpStore[email] = { otp, expires }

  try {
    await transporter.sendMail({
      from:    `"CashLens" <${process.env.EMAIL_USER}>`,
      to:      email,
      subject: 'Your CashLens OTP',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:2rem;border:1px solid #e0e0d8;border-radius:12px;">
          <h2 style="color:#185FA5;margin-bottom:8px;">💰 CashLens</h2>
          <p style="color:#555;margin-bottom:1.5rem;">Your one-time verification code is:</p>
          <div style="font-size:36px;font-weight:700;color:#1a1a1a;letter-spacing:8px;text-align:center;padding:1rem;background:#f5f5f0;border-radius:8px;margin-bottom:1.5rem;">
            ${otp}
          </div>
          <p style="color:#888;font-size:13px;">This OTP expires in 10 minutes. Do not share it with anyone.</p>
        </div>
      `
    })
    console.log(`OTP sent to ${email}: ${otp}`)
    res.json({ message: 'OTP sent to your email!' })
  } catch (e) {
    console.error('Email error:', e.message)
    // Fallback — return OTP in response for demo if email fails
    res.json({ message: 'OTP generated (demo mode)', demoOtp: otp })
  }
})

// Verify OTP
app.post('/auth/verify-otp', (req, res) => {
  const { email, otp } = req.body
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' })

  const stored = otpStore[email]
  if (!stored)
    return res.status(400).json({ error: 'No OTP sent to this email. Click Send OTP first.' })
  if (Date.now() > stored.expires)
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' })
  if (stored.otp !== otp.toString())
    return res.status(400).json({ error: 'Incorrect OTP. Please try again.' })

  // OTP verified — clear it
  delete otpStore[email]
  res.json({ message: 'OTP verified!', verified: true })
})


// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// Register
app.post('/auth/register', async (req, res) => {
  const { name, email, phone, password } = req.body
  if (!name || !password)
    return res.status(400).json({ error: 'Name and password are required' })
  if (!email && !phone)
    return res.status(400).json({ error: 'Email or phone number is required' })

  try {
    const hashed = await bcrypt.hash(password, 10)
    const sql = `INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)`
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
      res.json({ message: 'Account created!', token, name })
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Login
app.post('/auth/login', async (req, res) => {
  const { identifier, password } = req.body
  if (!identifier || !password)
    return res.status(400).json({ error: 'All fields are required' })

  db.query(
    'SELECT * FROM users WHERE email = ? OR phone = ? LIMIT 1',
    [identifier, identifier],
    async (err, results) => {
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
    }
  )
})


// ══════════════════════════════════════════════════════════════
//  CATEGORIES
// ══════════════════════════════════════════════════════════════
app.get('/categories', auth, (req, res) => {
  db.query('SELECT * FROM categories ORDER BY label', (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})


// ══════════════════════════════════════════════════════════════
//  EXPENSES
// ══════════════════════════════════════════════════════════════
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
  db.query(
    sql,
    [name, amount, category_code, is_needed, note||'', expense_date, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })

      // Check budget after adding expense
      const checkSql = `
        SELECT
          COALESCE(ms.total_amount, 0) AS total_spent,
          COALESCE(b.monthly_limit,  0) AS budget_limit
        FROM (SELECT 1) d
        LEFT JOIN monthly_summary ms
          ON ms.month_user = CONCAT(?, '_', ?)
        LEFT JOIN budget b
          ON b.month_year = ? AND b.user_id = ?
      `
      db.query(checkSql, [month, req.user.id, month, req.user.id], (err2, rows) => {
        if (err2)
          return res.json({ message: 'Expense added!', id: result.insertId, budgetStatus: null })

        const totalSpent  = parseFloat(rows[0].total_spent)  || 0
        const budgetLimit = parseFloat(rows[0].budget_limit) || 0

        if (budgetLimit === 0)
          return res.json({ message: 'Expense added!', id: result.insertId, budgetStatus: 'no_budget' })

        const pct        = Math.round((totalSpent / budgetLimit) * 100)
        const exceededBy = totalSpent - budgetLimit

        if (totalSpent > budgetLimit) {
          db.query(
            `INSERT INTO budget_alerts
               (month_year, expense_name, expense_amount, total_after, budget_limit, exceeded_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [month, name, amount, totalSpent, budgetLimit, exceededBy],
            () => {}
          )
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


// ══════════════════════════════════════════════════════════════
//  BUDGET
// ══════════════════════════════════════════════════════════════
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
    return res.status(400).json({ error: 'Valid month and budget amount required' })

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


// ══════════════════════════════════════════════════════════════
//  MONTHLY SUMMARY
// ══════════════════════════════════════════════════════════════
app.get('/summary', auth, (req, res) => {
  const sql = `
    SELECT
      ms.month_year,
      ms.total_amount,
      ms.essential_amount,
      ms.waste_amount,
      ms.reducible_amount,
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


// ══════════════════════════════════════════════════════════════
//  WASTE
// ══════════════════════════════════════════════════════════════
app.get('/waste', auth, (req, res) => {
  const sql = `
    SELECT
      e.id, e.name, e.amount, e.is_needed, e.note,
      DATE_FORMAT(e.expense_date, '%Y-%m-%d') AS expense_date,
      c.label AS category_label,
      c.emoji AS category_emoji,
      (e.amount * 12) AS yearly_projection
    FROM expenses e
    JOIN categories c ON e.category_code = c.code
    WHERE e.is_needed IN ('no', 'maybe')
      AND e.user_id = ?
    ORDER BY e.amount DESC
  `
  db.query(sql, [req.user.id], (err, results) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json(results)
  })
})


// ══════════════════════════════════════════════════════════════
//  AUDIT LOG
// ══════════════════════════════════════════════════════════════
app.get('/audit', auth, (req, res) => {
  db.query(
    'SELECT * FROM expense_audit_log ORDER BY action_time DESC LIMIT 50',
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(results)
    }
  )
})


// ══════════════════════════════════════════════════════════════
//  INCOME
// Uses a separate income table (created on first run)
//══════════════════════════════════════════════════════════════
app.get('/income', auth, (req, res) => {
  db.query(
    `CREATE TABLE IF NOT EXISTS income (
       id         INT AUTO_INCREMENT PRIMARY KEY,
       name       VARCHAR(255)   NOT NULL,
       amount     DECIMAL(10,2)  NOT NULL,
       category   VARCHAR(50)    NOT NULL DEFAULT 'salary',
       note       VARCHAR(500),
       income_date DATE          NOT NULL,
       created_at TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
       user_id    INT,
       CONSTRAINT fk_income_user
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    () => {
      db.query(
        `SELECT * FROM income WHERE user_id = ? ORDER BY income_date DESC, created_at DESC`,
        [req.user.id],
        (err, results) => {
          if (err) return res.status(500).json({ error: err.message })
          res.json(results)
        }
      )
    }
  )
})

app.post('/income', auth, (req, res) => {
  const { name, amount, category, note, income_date } = req.body
  if (!name || !amount || !income_date)
    return res.status(400).json({ error: 'Name, amount and date are required' })
  if (amount <= 0)
    return res.status(400).json({ error: 'Amount must be greater than 0' })

  db.query(
    `INSERT INTO income (name, amount, category, note, income_date, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, amount, category||'salary', note||'', income_date, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ message: 'Income added!', id: result.insertId })
    }
  )
})

app.delete('/income/:id', auth, (req, res) => {
  db.query(
    'DELETE FROM income WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      if (result.affectedRows === 0)
        return res.status(404).json({ error: 'Income entry not found' })
      res.json({ message: 'Income deleted!' })
    }
  )
})


// ══════════════════════════════════════════════════════════════
//  SAVINGS GOALS
// ══════════════════════════════════════════════════════════════
app.get('/goals', auth, (req, res) => {
  db.query(
    `CREATE TABLE IF NOT EXISTS savings_goals (
       id           INT AUTO_INCREMENT PRIMARY KEY,
       name         VARCHAR(255)   NOT NULL,
       icon         VARCHAR(10)    DEFAULT '🎯',
       target_amount DECIMAL(10,2) NOT NULL,
       saved_amount  DECIMAL(10,2) DEFAULT 0,
       deadline     DATE,
       created_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
       user_id      INT,
       CONSTRAINT fk_goal_user
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
    () => {
      db.query(
        'SELECT * FROM savings_goals WHERE user_id = ? ORDER BY created_at DESC',
        [req.user.id],
        (err, results) => {
          if (err) return res.status(500).json({ error: err.message })
          res.json(results)
        }
      )
    }
  )
})

app.post('/goals', auth, (req, res) => {
  const { name, icon, target_amount, saved_amount, deadline } = req.body
  if (!name || !target_amount || target_amount <= 0)
    return res.status(400).json({ error: 'Name and target amount are required' })

  db.query(
    `INSERT INTO savings_goals (name, icon, target_amount, saved_amount, deadline, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, icon||'🎯', target_amount, saved_amount||0, deadline||null, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ message: 'Goal added!', id: result.insertId })
    }
  )
})

app.patch('/goals/:id', auth, (req, res) => {
  const { saved_amount } = req.body
  db.query(
    'UPDATE savings_goals SET saved_amount = ? WHERE id = ? AND user_id = ?',
    [saved_amount, req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      if (result.affectedRows === 0)
        return res.status(404).json({ error: 'Goal not found' })
      res.json({ message: 'Goal updated!' })
    }
  )
})

app.delete('/goals/:id', auth, (req, res) => {
  db.query(
    'DELETE FROM savings_goals WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message })
      if (result.affectedRows === 0)
        return res.status(404).json({ error: 'Goal not found' })
      res.json({ message: 'Goal deleted!' })
    }
  )
})


// ══════════════════════════════════════════════════════════════
//  BUDGET ALERTS HISTORY
// ══════════════════════════════════════════════════════════════
app.get('/alerts', auth, (req, res) => {
  db.query(
    'SELECT * FROM budget_alerts ORDER BY alert_time DESC LIMIT 50',
    (err, results) => {
      if (err) return res.status(500).json({ error: err.message })
      res.json(results)
    }
  )
})


// ══════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🚀 CashLens server running on port ${PORT}`)
})
