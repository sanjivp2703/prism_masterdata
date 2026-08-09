-- ============================================================================
-- Prism DEMO / DEV DATA — Snowflake
--
-- DEV AND DEMO ACCOUNTS ONLY — never run on a customer account. Customers run
-- only 00_bootstrap.sql + 01_internal_tables.sql (served by the setup wizard);
-- this file carries the fake source data and dev-account conveniences:
--   * TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT — the two-column demo source
--     table with sample carrier/company values
--   * dev grants: TEST_DB access for PRISM_SERVICE + the dev user's roles
--   * (TEMP-disabled) pre-confirmed lookup seed for the demo values
--
-- Run AFTER 00_bootstrap.sql + 01_internal_tables.sql:
--     snowsql -f 02_demo_data.sql
-- Re-running resets the demo source table (CREATE OR REPLACE).
-- ============================================================================

USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS TEST_DB;
CREATE SCHEMA IF NOT EXISTS TEST_DB.PUBLIC;

-- ----------------------------------------------------------------------------
-- DEMO SOURCE TABLE — RAW_MOBILE_CARRIERS_SHORT
-- A two-column source table: RAW_CARRIER_VALUE standardizes as mobile
-- carriers, RAW_COMPANY_VALUE as company names.
-- ----------------------------------------------------------------------------
-- CHANGE_TRACKING = TRUE: creating the FIRST stream on a table auto-enables
-- change tracking, which requires MODIFY — PRISM_SERVICE only gets SELECT on
-- source tables. Enabling it at create time lets the poller create its stream
-- without extra grants. Real customer tables need the same, run by the owner:
--   ALTER TABLE <fqn> SET CHANGE_TRACKING = TRUE;
CREATE OR REPLACE TABLE TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT (
    RAW_CARRIER_VALUE VARCHAR,
    RAW_COMPANY_VALUE VARCHAR
) CHANGE_TRACKING = TRUE;
INSERT INTO TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES
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

-- ----------------------------------------------------------------------------
-- DEV GRANTS
-- TEST_DB source/export access for the service role (mirrors the wizard's
-- Part D data-access grants), plus the dev human user's roles. On a customer
-- account the wizard generates the source-schema grants and step 2 creates
-- the PRISM_SVC service user instead.
-- ----------------------------------------------------------------------------
GRANT USAGE        ON DATABASE TEST_DB        TO ROLE PRISM_SERVICE;
GRANT USAGE        ON SCHEMA   TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT SELECT       ON ALL TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT SELECT       ON FUTURE TABLES IN SCHEMA TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT CREATE TABLE ON SCHEMA   TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;
GRANT CREATE VIEW  ON SCHEMA   TEST_DB.PUBLIC TO ROLE PRISM_SERVICE;

-- Dev account: the backend connects as the dev human user, who therefore
-- holds the service role directly (a customer install uses PRISM_SVC).
GRANT ROLE PRISM_SERVICE    TO USER SANJIVP2703;
GRANT ROLE PRISM_DATA_ADMIN TO USER SANJIVP2703;

-- ----------------------------------------------------------------------------
-- PRE-CONFIRMED LOOKUP SEED (currently disabled)
-- Canonical alias names + confirmed literal→alias mappings for the demo
-- values, so both columns arrive already standardized. Re-enable the blocks
-- below (with the app-side spec seeds) to restore the pre-confirmed demo
-- lookup. (run_id 0 is a seed sentinel — Snowflake does not enforce FKs.)
-- ----------------------------------------------------------------------------
USE DATABASE PRISM_DB;
USE SCHEMA INTERNAL;

-- TEMP: initial standardizations (canonical alias names + the confirmed
-- literal→alias mappings below) disabled — re-enable (with the domains seed) to
-- restore the pre-confirmed demo lookup.
/*
INSERT INTO APPROVED_ALIAS_NAMES (alias_name, domain_id)
SELECT canon, 1  -- 1 = 'Mobile Carriers' (SQLite domains seed)
FROM VALUES
  ('AT&T'),('Verizon'),('T-Mobile'),('Sprint'),('Boost Mobile'),
  ('Cricket Wireless'),('Metro by T-Mobile'),('UScellular'),('Capital One')
  AS t(canon)
UNION ALL
SELECT canon, 2  -- 2 = 'Company Names' (SQLite domains seed)
FROM VALUES
  ('Goldman Sachs'),('JPMorgan Chase'),('McKinsey & Company'),('Deloitte'),('PwC'),
  ('Ernst & Young'),('KPMG'),('Bain & Company'),('Boston Consulting Group'),('Accenture')
  AS t(canon);

-- Confirmed literal -> alias mappings: first column into Mobile Carrier...
INSERT INTO LITERAL_ALIAS_MATCHES (literal_value, normalized_value, alias_id, domain_id, run_id)
SELECT m.lit, PRISM_NORMALIZE(m.lit), a.alias_id, a.domain_id, 0
FROM VALUES
  ('AT&T','AT&T'),
  ('ATT','AT&T'),
  ('A T & T','AT&T'),
  ('American Telephone and Telegraph','AT&T'),
  ('American Telephone & Telegraph Company','AT&T'),
  ('AT and T','AT&T'),
  ('Verizon','Verizon'),
  ('Verizon Wireless','Verizon'),
  ('Verizon Wirless','Verizon'),
  ('VZW','Verizon'),
  ('Verizon Communications','Verizon'),
  ('T-Mobile','T-Mobile'),
  ('T Mobile','T-Mobile'),
  ('TMobile','T-Mobile'),
  ('T-Mobile USA','T-Mobile'),
  ('Sprint','Sprint'),
  ('Sprint PCS','Sprint'),
  ('Boost Mobile','Boost Mobile'),
  ('Boost','Boost Mobile'),
  ('Cricket','Cricket Wireless'),
  ('Cricket Wireless','Cricket Wireless'),
  ('MetroPCS','Metro by T-Mobile'),
  ('Metro PCS','Metro by T-Mobile'),
  ('Metro by T-Mobile','Metro by T-Mobile'),
  ('US Cellular','UScellular'),
  ('USCellular','UScellular'),
  ('Capital One','Capital One'),
  ('C1','Capital One')
  AS m(lit, canon)
JOIN APPROVED_ALIAS_NAMES a
  ON a.alias_name = m.canon
 AND a.domain_id = 1  -- 1 = 'Mobile Carriers' (SQLite domains seed)
UNION ALL
-- ...second column into Company Name.
SELECT m.lit, PRISM_NORMALIZE(m.lit), a.alias_id, a.domain_id, 0
FROM VALUES
  ('Goldman Sachs','Goldman Sachs'),
  ('Goldman Sachs & Co','Goldman Sachs'),
  ('Goldman Sachs Group','Goldman Sachs'),
  ('JPMorgan','JPMorgan Chase'),
  ('JP Morgan Chase','JPMorgan Chase'),
  ('JPMorgan Chase & Co.','JPMorgan Chase'),
  ('McKinsey','McKinsey & Company'),
  ('McKinsey & Company','McKinsey & Company'),
  ('McKinsey and Company Inc','McKinsey & Company'),
  ('Deloitte','Deloitte'),
  ('Deloitte LLP','Deloitte'),
  ('Deloitte Touche Tohmatsu','Deloitte'),
  ('PricewaterhouseCoopers','PwC'),
  ('PwC','PwC'),
  ('Pricewaterhouse Coopers LLP','PwC'),
  ('Ernst & Young','Ernst & Young'),
  ('EY','Ernst & Young'),
  ('Ernst and Young LLP','Ernst & Young'),
  ('KPMG','KPMG'),
  ('KPMG International','KPMG'),
  ('Bain & Company','Bain & Company'),
  ('Bain and Co','Bain & Company'),
  ('Bain','Bain & Company'),
  ('Boston Consulting Group','Boston Consulting Group'),
  ('BCG','Boston Consulting Group'),
  ('The Boston Consulting Group','Boston Consulting Group'),
  ('Accenture','Accenture'),
  ('Accenture PLC','Accenture')
  AS m(lit, canon)
JOIN APPROVED_ALIAS_NAMES a
  ON a.alias_name = m.canon
 AND a.domain_id = 2;  -- 2 = 'Company Names' (SQLite domains seed)
*/
