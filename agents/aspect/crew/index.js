/**
 * Aspect Agent Crew Members
 *
 * Export all crew members for the Aspect agent.
 * The crew service will load these automatically.
 */

const AspectTechnologyCrew = require('./technology.crew');
const AspectFashionCrew = require('./fashion.crew');
const AspectFMCGCrew = require('./fmcg.crew');
const Zer4UCrew = require('./zer4u.crew');

module.exports = {
  AspectTechnologyCrew,
  AspectFashionCrew,
  AspectFMCGCrew,
  Zer4UCrew
};
