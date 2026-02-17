/**
 * Freeda Agent Crew Members
 *
 * Export all crew members for the Freeda agent.
 * The crew service will load these automatically.
 *
 * Flow: Introduction (default) → eligibility check → Profiler (orientation & journey profiling)
 *                                                  → SymptomAssessment (3 symptom groups)
 *                                                  → AssessmentClosure (summary & companion positioning)
 *                                                  → General (treatment guidance)
 *                                                  → Ineligible (if under 38 or male)
 */

const FreedaIntroductionCrew = require('./introduction.crew');
const FreedaProfilerCrew = require('./profiler.crew');
const FreedaWelcomeCrew = require('./welcome.crew');
const FreedaGeneralCrew = require('./general.crew');
const FreedaSymptomAssessmentCrew = require('./symptom-assessment.crew');
const FreedaAssessmentClosureCrew = require('./assessment-closure.crew');

module.exports = {
  FreedaIntroductionCrew,
  FreedaProfilerCrew,
  FreedaWelcomeCrew,
  FreedaGeneralCrew,
  FreedaSymptomAssessmentCrew,
  FreedaAssessmentClosureCrew
};
