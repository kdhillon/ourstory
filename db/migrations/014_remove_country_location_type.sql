-- Migration 014: Reclassify location_type='country' → 'region'
--
-- The "country" location type was a rough proxy for sovereign political entities.
-- Now that polities are a first-class data type, country-type locations serve only
-- as geographic coordinate anchors for events. We unify them with 'region' so the
-- location filter UI no longer shows a redundant "Country" category.
--
-- Events that have location_level='country' in the events table are unaffected;
-- that column records how the event was geolocated (via a country-level entity),
-- not the display type.

UPDATE locations
SET location_type = 'region'
WHERE location_type = 'country';
