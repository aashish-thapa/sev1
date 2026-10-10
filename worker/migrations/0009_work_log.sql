-- Daily company work, graded on the server: one attempt per member, task and UTC day.
-- `settled_work_day` is set when a closed work day counts the row, so nothing is counted twice.
CREATE TABLE work_log (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  outcome TEXT NOT NULL,
  is_done INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  answered_at INTEGER NOT NULL,
  settled_work_day INTEGER,
  UNIQUE (user_id, task_id, utc_day)
);
CREATE INDEX work_log_unsettled ON work_log (company_id, settled_work_day);
CREATE INDEX work_log_by_user ON work_log (user_id, utc_day);
