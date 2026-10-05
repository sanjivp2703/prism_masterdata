/**
 * Sample data for the public /demo page.
 *
 * Everything here is invented. The demo never calls the API, a warehouse or an
 * AI provider — the "auto group" result is the pre-written grouping below, so
 * the page is safe to expose without a session and costs nothing to run.
 * (Pure module — no `server-only`.)
 */

export interface DemoItem {
  value:        string;
  /** How many source rows carry this exact value. */
  count:        number;
  /** Simulated grouping confidence, 0–1. */
  confidence:   number;
  /** Flagged for a human to check (rendered as a yellow chip). */
  needsReview?: boolean;
}

export interface DemoGroup {
  id:    string;
  name:  string;
  items: DemoItem[];
}

/** A value that "arrives" after export, to show the automated pipeline. */
export interface DemoIncoming {
  value: string;
  count: number;
  /** The group the simulated AI places it in. Ignored when the value is
   *  already in the lookup — known values follow the reviewer's mapping. */
  groupId: string;
}

export interface DemoDataset {
  key:         string;
  label:       string;
  blurb:       string;
  tableFqn:    string;
  column:      string;
  /** A second column, so the preview reads like a real table. */
  otherColumn: { name: string; values: string[] };
  spec: {
    description: string;
    rules:       string[];
    convention:  string;
  };
  groups:   DemoGroup[];
  incoming: DemoIncoming[];
}

export const DEMO_DATASETS: DemoDataset[] = [
  {
    key:      'carriers',
    label:    'Mobile carriers',
    blurb:    'Carrier names typed by support agents',
    tableFqn: 'DEMO.PUBLIC.CUSTOMER_ACCOUNTS',
    column:   'CARRIER',
    otherColumn: { name: 'PLAN', values: ['Unlimited', 'Prepaid', 'Family', 'Business'] },
    spec: {
      description: 'The mobile network carrier on the customer account.',
      rules: [
        'Keep prepaid brands separate from their parent carrier.',
        'Ignore words like "wireless", "mobility" and "US".',
      ],
      convention: 'Official brand name, as the carrier writes it',
    },
    groups: [
      { id: 'att', name: 'AT&T', items: [
        { value: 'att',            count: 41, confidence: 0.98 },
        { value: 'AT&T wireless',  count: 27, confidence: 0.97 },
        { value: 'a t and t',      count: 6,  confidence: 0.93 },
        { value: 'AT and T',       count: 9,  confidence: 0.95 },
        { value: 'ATT Mobility',   count: 12, confidence: 0.94 },
        { value: 'at&t',           count: 33, confidence: 0.99 },
      ] },
      { id: 'verizon', name: 'Verizon', items: [
        { value: 'verizon',          count: 38, confidence: 0.99 },
        { value: 'VZW',              count: 14, confidence: 0.91 },
        { value: 'Verizon Wireless', count: 29, confidence: 0.98 },
        { value: 'verizn',           count: 3,  confidence: 0.88 },
        { value: 'VERIZON WIRELESS', count: 11, confidence: 0.98 },
      ] },
      { id: 'tmobile', name: 'T-Mobile', items: [
        { value: 'tmobile',       count: 35, confidence: 0.98 },
        { value: 'T Mobile',      count: 18, confidence: 0.98 },
        { value: 't-mobile usa',  count: 7,  confidence: 0.96 },
        { value: 'TMO',           count: 5,  confidence: 0.84 },
        { value: 'T-Mobile US',   count: 10, confidence: 0.97 },
      ] },
      { id: 'metro', name: 'Metro by T-Mobile', items: [
        { value: 'metro pcs',         count: 9, confidence: 0.92 },
        { value: 'MetroPCS',          count: 8, confidence: 0.95 },
        { value: 'metro by tmobile',  count: 4, confidence: 0.97 },
      ] },
      { id: 'cricket', name: 'Cricket Wireless', items: [
        { value: 'cricket',           count: 13, confidence: 0.94 },
        { value: 'Cricket wireless',  count: 6,  confidence: 0.99 },
      ] },
      { id: 'uscc', name: 'UScellular', items: [
        { value: 'us cellular',    count: 8, confidence: 0.96 },
        { value: 'U.S. Cellular',  count: 7, confidence: 0.97 },
        { value: 'USCC',           count: 2, confidence: 0.81 },
      ] },
      { id: 'sprint', name: 'Sprint', items: [
        { value: 'Sprint',      count: 12, confidence: 0.62, needsReview: true },
        { value: 'sprint pcs',  count: 3,  confidence: 0.58, needsReview: true },
      ] },
      { id: 'mint', name: 'Mint Mobile', items: [
        { value: 'Mint', count: 4, confidence: 0.66, needsReview: true },
      ] },
    ],
    incoming: [
      { value: 'at&t',              count: 5, groupId: 'att' },
      { value: 'Verizon Wireless',  count: 3, groupId: 'verizon' },
      { value: 'AT&T Mobility LLC', count: 2, groupId: 'att' },
      { value: 'T-Mobile (TMUS)',   count: 1, groupId: 'tmobile' },
      { value: 'mint mobile',       count: 2, groupId: 'mint' },
    ],
  },
  {
    key:      'vendors',
    label:    'Vendor names',
    blurb:    'Supplier names keyed into invoices',
    tableFqn: 'DEMO.FINANCE.VENDOR_INVOICES',
    column:   'VENDOR_NAME',
    otherColumn: { name: 'CURRENCY', values: ['USD', 'USD', 'EUR', 'USD', 'GBP'] },
    spec: {
      description: 'The supplier a finance invoice was issued by.',
      rules: [
        'Drop legal suffixes such as Inc, Corp, LLC and LLP.',
        'Treat a product line as its own vendor when it invoices separately.',
      ],
      convention: 'Common trading name, title case',
    },
    groups: [
      { id: 'microsoft', name: 'Microsoft', items: [
        { value: 'Microsoft Corp',         count: 22, confidence: 0.99 },
        { value: 'MSFT',                   count: 6,  confidence: 0.90 },
        { value: 'microsoft corporation',  count: 15, confidence: 0.99 },
        { value: 'Micro soft',             count: 2,  confidence: 0.86 },
        { value: 'Microsoft Inc.',         count: 9,  confidence: 0.98 },
      ] },
      { id: 'aws', name: 'Amazon Web Services', items: [
        { value: 'AWS',                  count: 31, confidence: 0.97 },
        { value: 'amazon web services',  count: 12, confidence: 0.99 },
        { value: 'Amazon Web Svcs',      count: 4,  confidence: 0.95 },
        { value: 'AWS Inc',              count: 7,  confidence: 0.97 },
      ] },
      { id: 'google', name: 'Google', items: [
        { value: 'Google LLC',    count: 17, confidence: 0.99 },
        { value: 'google',        count: 11, confidence: 0.99 },
        { value: 'Google Inc.',   count: 5,  confidence: 0.98 },
        { value: 'Googel',        count: 1,  confidence: 0.83 },
      ] },
      { id: 'salesforce', name: 'Salesforce', items: [
        { value: 'salesforce.com',  count: 14, confidence: 0.98 },
        { value: 'SFDC',            count: 8,  confidence: 0.89 },
        { value: 'Sales Force',     count: 3,  confidence: 0.92 },
        { value: 'Salesforce Inc',  count: 10, confidence: 0.99 },
      ] },
      { id: 'ibm', name: 'IBM', items: [
        { value: 'IBM',                              count: 19, confidence: 0.99 },
        { value: 'I.B.M.',                           count: 2,  confidence: 0.96 },
        { value: 'Intl Business Machines',           count: 3,  confidence: 0.93 },
        { value: 'International Business Machines',  count: 6,  confidence: 0.98 },
      ] },
      { id: 'fedex', name: 'FedEx', items: [
        { value: 'Fed Ex',           count: 9,  confidence: 0.97 },
        { value: 'FEDEX CORP',       count: 13, confidence: 0.99 },
        { value: 'Federal Express',  count: 4,  confidence: 0.94 },
        { value: 'fedex',            count: 16, confidence: 0.99 },
      ] },
      { id: 'deloitte', name: 'Deloitte', items: [
        { value: 'Deloitte',      count: 8, confidence: 0.99 },
        { value: 'Deloitte LLP',  count: 5, confidence: 0.99 },
        { value: 'Delloite',      count: 2, confidence: 0.87 },
      ] },
      { id: 'amazon', name: 'Amazon', items: [
        { value: 'Amazon', count: 10, confidence: 0.55, needsReview: true },
      ] },
    ],
    incoming: [
      { value: 'AWS',                    count: 6, groupId: 'aws' },
      { value: 'fedex',                  count: 2, groupId: 'fedex' },
      { value: 'Microsoft Ireland Ltd',  count: 1, groupId: 'microsoft' },
      { value: 'Sales-force',            count: 1, groupId: 'salesforce' },
      { value: 'Deloitte & Touche',      count: 3, groupId: 'deloitte' },
    ],
  },
  {
    key:      'countries',
    label:    'Countries',
    blurb:    'A free-text country field from a signup form',
    tableFqn: 'DEMO.CRM.CONTACTS',
    column:   'COUNTRY',
    otherColumn: { name: 'SEGMENT', values: ['Enterprise', 'Startup', 'Mid-market'] },
    spec: {
      description: 'The country a contact entered on the signup form.',
      rules: [
        'Map country codes and local-language names to the country.',
        'Keep the constituent countries of the UK under United Kingdom.',
      ],
      convention: 'Full English country name',
    },
    groups: [
      { id: 'us', name: 'United States', items: [
        { value: 'USA',                       count: 44, confidence: 0.99 },
        { value: 'U.S.',                      count: 12, confidence: 0.98 },
        { value: 'US',                        count: 37, confidence: 0.97 },
        { value: 'United States of America',  count: 8,  confidence: 0.99 },
        { value: 'america',                   count: 3,  confidence: 0.85 },
        { value: 'U.S.A.',                    count: 6,  confidence: 0.99 },
      ] },
      { id: 'uk', name: 'United Kingdom', items: [
        { value: 'UK',              count: 26, confidence: 0.99 },
        { value: 'U.K.',            count: 5,  confidence: 0.99 },
        { value: 'Great Britain',   count: 4,  confidence: 0.92 },
        { value: 'united kingdom',  count: 9,  confidence: 0.99 },
        { value: 'England',         count: 7,  confidence: 0.68, needsReview: true },
      ] },
      { id: 'de', name: 'Germany', items: [
        { value: 'DE',           count: 11, confidence: 0.95 },
        { value: 'Deutschland',  count: 6,  confidence: 0.98 },
        { value: 'germany',      count: 14, confidence: 0.99 },
        { value: 'GER',          count: 2,  confidence: 0.90 },
      ] },
      { id: 'mx', name: 'Mexico', items: [
        { value: 'MX',      count: 5, confidence: 0.95 },
        { value: 'México',  count: 8, confidence: 0.99 },
        { value: 'mexico',  count: 7, confidence: 0.99 },
      ] },
      { id: 'ca', name: 'Canada', items: [
        { value: 'CAN',     count: 6,  confidence: 0.96 },
        { value: 'canada',  count: 13, confidence: 0.99 },
        { value: 'Canda',   count: 1,  confidence: 0.86 },
      ] },
      { id: 'nl', name: 'Netherlands', items: [
        { value: 'Holland',          count: 4, confidence: 0.91 },
        { value: 'NL',               count: 3, confidence: 0.95 },
        { value: 'The Netherlands',  count: 6, confidence: 0.99 },
      ] },
      { id: 'kr', name: 'South Korea', items: [
        { value: 'Republic of Korea',  count: 3, confidence: 0.97 },
        { value: 'S. Korea',           count: 2, confidence: 0.96 },
        { value: 'Korea',              count: 5, confidence: 0.64, needsReview: true },
      ] },
    ],
    incoming: [
      { value: 'USA',               count: 9, groupId: 'us' },
      { value: 'germany',           count: 2, groupId: 'de' },
      { value: 'Untied States',     count: 1, groupId: 'us' },
      { value: 'Nederland',         count: 2, groupId: 'nl' },
      { value: 'Scotland',          count: 1, groupId: 'uk' },
    ],
  },
];
