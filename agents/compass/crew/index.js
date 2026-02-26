/**
 * Compass Agent — Crew Members
 *
 * Career Change Navigator demo agent.
 *
 * Flow:
 *   intake (default)
 *     → collects seeker_name, current_role, target_industry
 *     → preMessageTransfer writes seeker_profile to context
 *   self_assessment
 *     → 3-dimension assessment via record_assessment tool calls
 *     → postMessageTransfer writes assessment_results to context
 *   transition_plan (oneShot)
 *     → delivers personalized "Compass Report" reading all context
 *   coach
 *     → ongoing Q&A with KB + personalized context
 */
const CompassIntakeCrew = require('./intake.crew');
const CompassSelfAssessmentCrew = require('./self-assessment.crew');
const CompassTransitionPlanCrew = require('./transition-plan.crew');
const CompassCoachCrew = require('./coach.crew');

module.exports = {
  CompassIntakeCrew,
  CompassSelfAssessmentCrew,
  CompassTransitionPlanCrew,
  CompassCoachCrew
};
