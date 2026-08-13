-- ============================================================================
-- Prism DEMO / DEV DATA — MYSQL
--
-- DEV AND DEMO SERVERS ONLY — never run on a customer server. Customers run
-- only 01_internal_tables.mysql.sql (served by the setup wizard); this file
-- carries the fake source data:
--   * test_sources.raw_mobile_carriers_short — the two-column demo source
--     table with sample carrier/company values
--   * test_sources.legacy_latin1_carriers — a LATIN1-charset fixture for the
--     charset-coercion join path (binaryCompare — mainline for legacy MySQL
--     installs, see docs/MYSQL_PORT_PLAN.md §2.3)
--
-- Run AFTER 01_internal_tables.mysql.sql:
--   mysql -h <host> -u root -p < 02_demo_data.mysql.sql
-- or via the dev runner (runs both files):  cd stand-ui && npm run mysql:install
-- Re-running resets the demo tables (DROP + CREATE).
-- ============================================================================

CREATE DATABASE IF NOT EXISTS test_sources
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE test_sources;

DROP TABLE IF EXISTS test_sources.raw_mobile_carriers_short;
DROP TABLE IF EXISTS test_sources.legacy_latin1_carriers;

-- row_id PK: exercises the PK ordering tier of export builds in dev.
CREATE TABLE test_sources.raw_mobile_carriers_short (
    row_id            INT AUTO_INCREMENT PRIMARY KEY,
    raw_carrier_value VARCHAR(200) NULL,
    raw_company_value VARCHAR(200) NULL
) ENGINE=InnoDB;

INSERT INTO test_sources.raw_mobile_carriers_short (raw_carrier_value, raw_company_value) VALUES
('AT&T', 'Goldman Sachs'),
('ATT', 'Goldman Sachs & Co'),
('A T & T', 'Goldman Sachs Group'),
('American Telephone and Telegraph', 'JPMorgan'),
('American Telephone & Telegraph Company', 'JP Morgan Chase'),
('AT and T', 'JPMorgan Chase & Co.'),
('Verizon', 'McKinsey'),
('Verizon Wireless', 'McKinsey & Company'),
('Verizon Wirless', 'McKinsey and Company Inc'),
('VZW', 'Deloitte'),
('Verizon Communications', 'Deloitte LLP'),
('T-Mobile', 'Deloitte Touche Tohmatsu'),
('T Mobile', 'PricewaterhouseCoopers'),
('TMobile', 'PwC'),
('T-Mobile USA', 'Pricewaterhouse Coopers LLP'),
('Sprint', 'Ernst & Young'),
('Sprint PCS', 'EY'),
('Boost Mobile', 'Ernst and Young LLP'),
('Boost', 'KPMG'),
('Cricket', 'KPMG International'),
('Cricket Wireless', 'Bain & Company'),
('MetroPCS', 'Bain and Co'),
('Metro PCS', 'Bain'),
('Metro by T-Mobile', 'Boston Consulting Group'),
('US Cellular', 'BCG'),
('USCellular', 'The Boston Consulting Group'),
('Capital One', 'Accenture'),
('C1', 'Accenture PLC');

-- Legacy-charset fixture: latin1 column, mixed-case values. The byte-exact
-- staging joins must CONVERT(… USING utf8mb4) before collating — a bare
-- COLLATE utf8mb4_bin on this column is error 1253.
CREATE TABLE test_sources.legacy_latin1_carriers (
    row_id  INT AUTO_INCREMENT PRIMARY KEY,
    carrier VARCHAR(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL
) ENGINE=InnoDB;

INSERT INTO test_sources.legacy_latin1_carriers (carrier) VALUES
('ATT'), ('att'), ('Café Mobile'), ('VZW');

-- Dev grants: let the service role read the demo sources (mirrors the
-- per-database grant a customer's admin runs — see the template in
-- 01_internal_tables.mysql.sql).
GRANT SELECT ON test_sources.* TO 'prism_service';

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM test_sources.raw_mobile_carriers_short;  -- 28
