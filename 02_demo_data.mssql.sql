-- ============================================================================
-- Prism DEMO / DEV DATA — MICROSOFT SQL SERVER
--
-- DEV AND DEMO SERVERS ONLY — never run on a customer server. Customers run
-- only 01_internal_tables.mssql.sql (served by the setup wizard); this file
-- carries the fake source data:
--   * TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT — the two-column demo source
--     table with sample carrier/company values, Change Tracking enabled
--
-- Run AFTER 01_internal_tables.mssql.sql:
--   sqlcmd -S <server> -U sa -i 02_demo_data.mssql.sql
-- or via the dev runner (runs both files):
--   cd stand-ui && npm run mssql:install
-- Re-running resets the demo source table (DROP + CREATE).
-- ============================================================================

IF DB_ID('TEST_DB') IS NULL
  CREATE DATABASE TEST_DB;
GO

USE TEST_DB;
GO

DROP TABLE IF EXISTS dbo.RAW_MOBILE_CARRIERS_SHORT;
GO

-- ROW_ID identity PK: gives the table a primary key so Change Tracking (and
-- the PK ordering tier of export builds) can be exercised in dev. The
-- Snowflake demo table has no PK — keyless behavior is tested by simply not
-- creating one on a copy.
CREATE TABLE dbo.RAW_MOBILE_CARRIERS_SHORT (
    ROW_ID            INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    RAW_CARRIER_VALUE NVARCHAR(200) COLLATE Latin1_General_100_BIN2 NULL,
    RAW_COMPANY_VALUE NVARCHAR(200) COLLATE Latin1_General_100_BIN2 NULL
);
GO

INSERT INTO dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES
(N'AT&T', N'Goldman Sachs'),
(N'ATT', N'Goldman Sachs & Co'),
(N'A T & T', N'Goldman Sachs Group'),
(N'American Telephone and Telegraph', N'JPMorgan'),
(N'American Telephone & Telegraph Company', N'JP Morgan Chase'),
(N'AT and T', N'JPMorgan Chase & Co.'),
(N'Verizon', N'McKinsey'),
(N'Verizon Wireless', N'McKinsey & Company'),
(N'Verizon Wirless', N'McKinsey and Company Inc'),
(N'VZW', N'Deloitte'),
(N'Verizon Communications', N'Deloitte LLP'),
(N'T-Mobile', N'Deloitte Touche Tohmatsu'),
(N'T Mobile', N'PricewaterhouseCoopers'),
(N'TMobile', N'PwC'),
(N'T-Mobile USA', N'Pricewaterhouse Coopers LLP'),
(N'Sprint', N'Ernst & Young'),
(N'Sprint PCS', N'EY'),
(N'Boost Mobile', N'Ernst and Young LLP'),
(N'Boost', N'KPMG'),
(N'Cricket', N'KPMG International'),
(N'Cricket Wireless', N'Bain & Company'),
(N'MetroPCS', N'Bain and Co'),
(N'Metro PCS', N'Bain'),
(N'Metro by T-Mobile', N'Boston Consulting Group'),
(N'US Cellular', N'BCG'),
(N'USCellular', N'The Boston Consulting Group'),
(N'Capital One', N'Accenture'),
(N'C1', N'Accenture PLC');
GO

-- Dev convenience: enable Change Tracking on TEST_DB + the demo table so the
-- Phase 4 fast path can be developed against it. (Real customer DBs: the
-- onboarding flow / their DBA runs the equivalent — see the service-login
-- template in 01_internal_tables.mssql.sql.)
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_databases WHERE database_id = DB_ID('TEST_DB'))
  ALTER DATABASE TEST_DB SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
GO
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables WHERE object_id = OBJECT_ID('dbo.RAW_MOBILE_CARRIERS_SHORT'))
  ALTER TABLE dbo.RAW_MOBILE_CARRIERS_SHORT ENABLE CHANGE_TRACKING;
GO

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT; -- 28
