-- Hiring: postings, server-graded interviews (the answer key never leaves here) and applications.

-- A founder can let a member open postings and hire.
ALTER TABLE company_members ADD COLUMN can_hire INTEGER NOT NULL DEFAULT 0;

CREATE TABLE company_postings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  pay_cents INTEGER NOT NULL,
  min_career_level INTEGER NOT NULL,
  min_score INTEGER NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX company_postings_by_company ON company_postings (company_id, is_open);

-- One interview per posting and player at a time; `answer_key` is graded against, never sent.
CREATE TABLE company_interviews (
  id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES company_postings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seed TEXT NOT NULL,
  questions TEXT NOT NULL,
  answer_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX company_interviews_by_applicant ON company_interviews (posting_id, user_id, started_at);

-- One application per posting and player; created only by a graded interview.
CREATE TABLE company_applications (
  id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES company_postings(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interview_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  career_title TEXT NOT NULL,
  -- 'pending', 'hired' or 'rejected'.
  status TEXT NOT NULL DEFAULT 'pending',
  applied_at INTEGER NOT NULL,
  UNIQUE (posting_id, user_id)
);
CREATE INDEX company_applications_by_company ON company_applications (company_id, status);
CREATE INDEX company_applications_by_user ON company_applications (user_id);
