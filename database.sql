-- ============================================================
--  CASHLENS — Complete Database Setup
--  Run this entire file in MySQL / Railway once
--  TABLE ORDER IS IMPORTANT — do not change it
-- ============================================================


-- ============================================================
--  TABLE 1: users
--  Must come FIRST because other tables reference it
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(100) NOT NULL,
  email      VARCHAR(150) UNIQUE,
  phone      VARCHAR(15)  UNIQUE,
  password   VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
--  TABLE 2: categories
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  code  VARCHAR(50)  NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  emoji VARCHAR(10)  NOT NULL,
  color VARCHAR(20)  NOT NULL
);

INSERT IGNORE INTO categories (code, label, emoji, color) VALUES
  ('food',          'Food & Groceries',    '🛒', '#1D9E75'),
  ('rent',          'Rent / EMI',          '🏠', '#185FA5'),
  ('utils',         'Electricity & Water', '💡', '#BA7517'),
  ('transport',     'Transport',           '🚌', '#3B6D11'),
  ('health',        'Health & Medicine',   '💊', '#D85A30'),
  ('entertainment', 'Entertainment',       '🎮', '#7F77DD'),
  ('dining',        'Dining Out',          '🍽️', '#D4537E'),
  ('shopping',      'Shopping / Clothes',  '🛍️', '#E24B4A'),
  ('subs',          'Subscriptions',       '📱', '#534AB7'),
  ('education',     'Education',           '📚', '#0F6E56'),
  ('travel',        'Travel',              '✈️', '#378ADD'),
  ('misc',          'Miscellaneous',       '📦', '#888780');


-- ============================================================
--  TABLE 3: expenses
--  References users and categories
-- ============================================================
CREATE TABLE IF NOT EXISTS expenses (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255)   NOT NULL,
  amount        DECIMAL(10,2)  NOT NULL,
  CONSTRAINT chk_amount_positive CHECK (amount > 0),
  category_code VARCHAR(50)    NOT NULL,
  is_needed     VARCHAR(10)    NOT NULL DEFAULT 'yes',
  CONSTRAINT chk_is_needed CHECK (is_needed IN ('yes', 'no', 'maybe')),
  note          VARCHAR(500),
  expense_date  DATE           NOT NULL,
  created_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  user_id       INT,
  CONSTRAINT fk_category
    FOREIGN KEY (category_code)
    REFERENCES categories(code)
    ON DELETE CASCADE
    ON UPDATE CASCADE,
  CONSTRAINT fk_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);


-- ============================================================
--  TABLE 4: budget
--  References users
-- ============================================================
CREATE TABLE IF NOT EXISTS budget (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  month_year     VARCHAR(7)     NOT NULL,
  monthly_limit  DECIMAL(10,2)  NOT NULL,
  CONSTRAINT chk_budget_positive CHECK (monthly_limit > 0),
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  user_id        INT,
  CONSTRAINT fk_budget_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  UNIQUE KEY uk_budget_month_user (month_year, user_id)
);


-- ============================================================
--  TABLE 5: monthly_summary
--  Auto-maintained by triggers
--  month_user = month_year + '_' + user_id (e.g. '2026-09_2')
--  This makes it unique per user per month
-- ============================================================
CREATE TABLE IF NOT EXISTS monthly_summary (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  month_year       VARCHAR(7)     NOT NULL,
  total_amount     DECIMAL(10,2)  DEFAULT 0,
  essential_amount DECIMAL(10,2)  DEFAULT 0,
  waste_amount     DECIMAL(10,2)  DEFAULT 0,
  reducible_amount DECIMAL(10,2)  DEFAULT 0,
  last_updated     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  user_id          INT,
  month_user       VARCHAR(20),
  UNIQUE KEY uk_month_user (month_user)
);


-- ============================================================
--  TABLE 6: budget_alerts
--  Logs every time budget is exceeded
-- ============================================================
CREATE TABLE IF NOT EXISTS budget_alerts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  month_year      VARCHAR(7)     NOT NULL,
  expense_name    VARCHAR(255)   NOT NULL,
  expense_amount  DECIMAL(10,2)  NOT NULL,
  total_after     DECIMAL(10,2)  NOT NULL,
  budget_limit    DECIMAL(10,2)  NOT NULL,
  exceeded_by     DECIMAL(10,2)  NOT NULL,
  alert_time      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================
--  TABLE 7: expense_audit_log
--  Auto-maintained by triggers
-- ============================================================
CREATE TABLE IF NOT EXISTS expense_audit_log (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  expense_id   INT,
  expense_name VARCHAR(255),
  amount       DECIMAL(10,2),
  action       VARCHAR(20),
  action_time  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  note         VARCHAR(500)
);


-- ============================================================
--  TRIGGER 1: after_expense_insert
--  Fires after every INSERT on expenses
--  Updates monthly_summary per user per month
--  Logs high-value expenses (above 5000) to audit log
-- ============================================================
DELIMITER $$

CREATE TRIGGER after_expense_insert
AFTER INSERT ON expenses
FOR EACH ROW
BEGIN
  DECLARE v_month    VARCHAR(7);
  DECLARE v_key      VARCHAR(20);

  SET v_month = DATE_FORMAT(NEW.expense_date, '%Y-%m');
  SET v_key   = CONCAT(v_month, '_', IFNULL(NEW.user_id, 0));

  INSERT INTO monthly_summary
    (month_year, user_id, month_user,
     total_amount, essential_amount, waste_amount, reducible_amount)
  VALUES (
    v_month,
    NEW.user_id,
    v_key,
    NEW.amount,
    IF(NEW.is_needed = 'yes',   NEW.amount, 0),
    IF(NEW.is_needed = 'no',    NEW.amount, 0),
    IF(NEW.is_needed = 'maybe', NEW.amount, 0)
  )
  ON DUPLICATE KEY UPDATE
    total_amount     = total_amount     + NEW.amount,
    essential_amount = essential_amount + IF(NEW.is_needed = 'yes',   NEW.amount, 0),
    waste_amount     = waste_amount     + IF(NEW.is_needed = 'no',    NEW.amount, 0),
    reducible_amount = reducible_amount + IF(NEW.is_needed = 'maybe', NEW.amount, 0);

  IF NEW.amount > 5000 THEN
    INSERT INTO expense_audit_log (expense_id, expense_name, amount, action, note)
    VALUES (NEW.id, NEW.name, NEW.amount, 'INSERTED',
            'High-value expense flagged automatically');
  END IF;

END$$


-- ============================================================
--  TRIGGER 2: after_expense_delete
--  Fires after every DELETE on expenses
--  Subtracts from monthly_summary
--  Logs deletion to audit log
-- ============================================================
CREATE TRIGGER after_expense_delete
AFTER DELETE ON expenses
FOR EACH ROW
BEGIN
  DECLARE v_month VARCHAR(7);
  DECLARE v_key   VARCHAR(20);

  SET v_month = DATE_FORMAT(OLD.expense_date, '%Y-%m');
  SET v_key   = CONCAT(v_month, '_', IFNULL(OLD.user_id, 0));

  UPDATE monthly_summary
  SET
    total_amount     = total_amount     - OLD.amount,
    essential_amount = essential_amount - IF(OLD.is_needed = 'yes',   OLD.amount, 0),
    waste_amount     = waste_amount     - IF(OLD.is_needed = 'no',    OLD.amount, 0),
    reducible_amount = reducible_amount - IF(OLD.is_needed = 'maybe', OLD.amount, 0)
  WHERE month_user = v_key;

  INSERT INTO expense_audit_log (expense_id, expense_name, amount, action, note)
  VALUES (OLD.id, OLD.name, OLD.amount, 'DELETED', 'Expense removed by user');

END$$

DELIMITER ;
