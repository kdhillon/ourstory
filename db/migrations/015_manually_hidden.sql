-- Add manually_hidden flag to polities and events.
-- When true, the feature is excluded from the map display.

ALTER TABLE polities ADD COLUMN IF NOT EXISTS manually_hidden BOOL NOT NULL DEFAULT FALSE;
ALTER TABLE events   ADD COLUMN IF NOT EXISTS manually_hidden BOOL NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_polities_manually_hidden ON polities(manually_hidden) WHERE manually_hidden = TRUE;
CREATE INDEX IF NOT EXISTS idx_events_manually_hidden   ON events(manually_hidden)   WHERE manually_hidden = TRUE;
