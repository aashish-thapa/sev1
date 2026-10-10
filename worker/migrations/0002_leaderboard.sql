-- Ranking reads these instead of parsing each saved progress body; written with every save.
ALTER TABLE progress ADD COLUMN experience INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN title TEXT NOT NULL DEFAULT 'Intern';
ALTER TABLE progress ADD COLUMN featured_badge TEXT;
CREATE INDEX progress_by_experience ON progress (experience DESC, updated_at ASC);
