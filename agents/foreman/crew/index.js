/**
 * Foreman Agent Crew Members
 *
 * Foreman is an AI ERP / Master Data assistant for Israeli infrastructure
 * contractors. Crews:
 *
 *  - intake (default): Identifies the user's role and active project, then
 *    routes to the right specialist crew based on what they want to do.
 *  - quote_parser: Parses supplier price quotes (PDF / pasted text) and
 *    matches supplier SKUs to the master catalog. The signature feature.
 *  - boq_pricer: Builds & costs a Bill of Quantities (כתב כמויות) line by
 *    line, with master-SKU lookups and VAT-aware totals.
 *  - general: Open-ended ERP / procurement / construction-finance Q&A.
 *
 * Flow:
 *   intake → (quote_parser | boq_pricer | general) — chosen by user goal
 *   user can also switch crews manually via the crew selector tabs
 */

const ForemanIntakeCrew = require('./intake.crew');
const ForemanQuoteParserCrew = require('./quote-parser.crew');
const ForemanBoqPricerCrew = require('./boq-pricer.crew');
const ForemanGeneralCrew = require('./general.crew');

module.exports = {
  ForemanIntakeCrew,
  ForemanQuoteParserCrew,
  ForemanBoqPricerCrew,
  ForemanGeneralCrew
};
