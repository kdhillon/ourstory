-- Migration 005: store Wikidata P31 (instance-of) QIDs on events
--
-- Persists the raw P31 QIDs that were already extracted at pipeline time
-- but previously discarded after category assignment. Enables debugging
-- of miscategorised events and future fine-grained filtering.

ALTER TABLE events ADD COLUMN p31_qids TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_events_p31_qids ON events USING GIN (p31_qids);
