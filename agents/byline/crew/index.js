/**
 * Byline Bank RDDA Agent Crew Members
 *
 * Export all crew members for the Byline RDDA (Risk Due Diligence Assessment) agent.
 * The crew service will load these automatically.
 *
 * Flow:
 *   Welcome (default)
 *   → Customer Information & Business Background
 *   → Account Activity
 *   → Merchant Portfolio
 *   → Processing Activity
 *   → Digital Assets
 *   → BSA/AML, OFAC and Reg GG
 *   → Information Security
 *   → Prohibited & Restricted Merchants
 *   → Documentation Collection
 *   → Completion
 */

const BylineWelcomeCrew = require('./welcome.crew');
const BylineCustomerInfoCrew = require('./customer-info.crew');
const BylineAccountActivityCrew = require('./account-activity.crew');
const BylineMerchantPortfolioCrew = require('./merchant-portfolio.crew');
const BylineProcessingActivityCrew = require('./processing-activity.crew');
const BylineDigitalAssetsCrew = require('./digital-assets.crew');
const BylineBsaAmlCrew = require('./bsa-aml.crew');
const BylineInfoSecurityCrew = require('./info-security.crew');
const BylineProhibitedMerchantsCrew = require('./prohibited-merchants.crew');
const BylineDocumentationCrew = require('./documentation.crew');
const BylineCompletionCrew = require('./completion.crew');

module.exports = {
  BylineWelcomeCrew,
  BylineCustomerInfoCrew,
  BylineAccountActivityCrew,
  BylineMerchantPortfolioCrew,
  BylineProcessingActivityCrew,
  BylineDigitalAssetsCrew,
  BylineBsaAmlCrew,
  BylineInfoSecurityCrew,
  BylineProhibitedMerchantsCrew,
  BylineDocumentationCrew,
  BylineCompletionCrew
};
