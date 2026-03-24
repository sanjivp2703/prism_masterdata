-- Migration: rebuild TOKENS_SUMMARY with token_type + alias_id columns.
-- Safe to re-run: drops and recreates the table, then reloads sample data.
USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

-- Drop and recreate with correct schema.
CREATE OR REPLACE TABLE TOKENS_SUMMARY (
    tokens_summary_id INTEGER AUTOINCREMENT START 100 INCREMENT 1 PRIMARY KEY NOT NULL,
    token VARCHAR NOT NULL,
    position_in_signature INTEGER NOT NULL,
    -- standard / normalized: from RAW_VALUES; alias: from ALIASES.tokens (raw_value_id NULL).
    raw_value_id INTEGER,
    alias_id INTEGER,
    signature_length INTEGER NOT NULL,
    rarity FLOAT NOT NULL DEFAULT 0,
    token_type VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT fk_tokens_summary_raw_value FOREIGN KEY (raw_value_id) REFERENCES RAW_VALUES(raw_value_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_tokens_summary_alias FOREIGN KEY (alias_id) REFERENCES ALIASES(alias_id) ON UPDATE RESTRICT ON DELETE CASCADE
    -- token_type values: 'standard' | 'normalized' (raw_value_id set, alias_id NULL)
    --                    'alias'                   (alias_id set, raw_value_id NULL)
);

-- Reload standard + normalized rows from existing RAW_VALUES.
INSERT INTO TOKENS_SUMMARY (
  token, position_in_signature, raw_value_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
)
VALUES
  -- raw_value_id=1 'AT&T'  token sig A|T|T  /  norm att
  ('A',   1, 1, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',   2, 1, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',   3, 1, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 1, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=2 'ATT'
  ('ATT', 1, 2, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 2, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=3 'A T & T'
  ('A',   1, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',   2, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',   3, 3, NULL, 3, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('att', 1, 3, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=7 'Verizon'
  ('Verizon', 1, 7, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon', 1, 7, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=8 'Verizon Wireless'
  ('Verizon',  1, 8, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wireless', 2, 8, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon',  1, 8, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wireless', 2, 8, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=9 'Verizon Wirless'
  ('Verizon', 1, 9, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wirless', 2, 9, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('verizon', 1, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('wirless', 2, 9, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=12 'T-Mobile'
  ('T',      1, 12, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 12, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('t',      1, 12, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 12, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=13 'T Mobile'
  ('T',      1, 13, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 13, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('t',      1, 13, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 13, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=16 'Sprint'
  ('Sprint', 1, 16, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('sprint', 1, 16, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=18 'Boost Mobile'
  ('Boost',  1, 18, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, 18, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('boost',  1, 18, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('mobile', 2, 18, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=20 'Cricket'
  ('Cricket', 1, 20, NULL, 1, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cricket', 1, 20, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=22 'MetroPCS'
  ('Metro', 1, 22, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS',   2, 22, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metropcs', 1, 22, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=23 'Metro PCS'
  ('Metro', 1, 23, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS',   2, 23, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('metropcs', 1, 23, NULL, 1, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- raw_value_id=25 'US Cellular'
  ('US',       1, 25, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Cellular', 2, 25, NULL, 2, 0, 'standard',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('us',       1, 25, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cellular', 2, 25, NULL, 2, 0, 'normalized', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Alias rows (token_type='alias', alias_id set, raw_value_id NULL).
INSERT INTO TOKENS_SUMMARY (
  token, position_in_signature, raw_value_id, alias_id, signature_length, rarity, token_type, created_at, updated_at
)
VALUES
  -- alias_id=1  ATT
  ('ATT', 1, NULL, 1, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=2  Verizon
  ('Verizon', 1, NULL, 2, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=3  T|Mobile
  ('T',      1, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 3, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=4  Sprint
  ('Sprint', 1, NULL, 4, 1, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=5  Boost|Mobile
  ('Boost',  1, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 2, NULL, 5, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=6  Cricket|Wireless
  ('Cricket',  1, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Wireless', 2, NULL, 6, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=7  Metro|by|T|Mobile
  ('Metro',  1, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('by',     2, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('T',      3, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Mobile', 4, NULL, 7, 4, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=8  US|Cellular
  ('US',       1, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('Cellular', 2, NULL, 8, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- alias_id=9  Metro|PCS
  ('Metro', 1, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('PCS',   2, NULL, 9, 2, 0, 'alias', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

SELECT 'TOKENS_SUMMARY migrated: ' || COUNT(*)::VARCHAR || ' rows' FROM TOKENS_SUMMARY;
