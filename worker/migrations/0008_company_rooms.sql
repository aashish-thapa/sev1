-- Each company's private office room: a room code assigned the first time a member enters.
ALTER TABLE companies ADD COLUMN room_code TEXT;
CREATE UNIQUE INDEX companies_by_room_code ON companies (room_code) WHERE room_code IS NOT NULL;
