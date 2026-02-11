/**
 * Banking Onboarder Agent - Crew Members Index
 *
 * This agent handles the complete customer onboarding journey for banking services.
 * Crew members will be added here as they are implemented.
 */

const EntryIntroductionCrew = require('./entry-introduction.crew');
const AccountTypeCrew = require('./account-type.crew');
const ConsentsCrew = require('./consents.crew');
const IdentityVerificationCrew = require('./identity-verification.crew');
const KYCCrew = require('./kyc.crew');
const ProfileEnrichmentCrew = require('./profile-enrichment.crew');
const OffersTermsCrew = require('./offers-terms.crew');
const FinalConfirmationsCrew = require('./final-confirmations.crew');
const CompletionCrew = require('./completion.crew');

module.exports = {
  EntryIntroductionCrew,
  AccountTypeCrew,
  ConsentsCrew,
  IdentityVerificationCrew,
  KYCCrew,
  ProfileEnrichmentCrew,
  OffersTermsCrew,
  FinalConfirmationsCrew,
  CompletionCrew
};
