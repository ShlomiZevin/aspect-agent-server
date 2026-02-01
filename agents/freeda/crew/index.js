/**
 * Freeda Agent Crew Members
 *
 * Export all crew members for the Freeda agent.
 * The crew service will load these automatically.
 *
 * Flow: Welcome (default) → collects name + age → General (main conversation)
 */

const FreedaWelcomeCrew = require('./welcome.crew');
const FreedaGeneralCrew = require('./general.crew');

module.exports = {
  FreedaWelcomeCrew,
  FreedaGeneralCrew
};
