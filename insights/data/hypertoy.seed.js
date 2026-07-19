/**
 * Static dataset branding for the Aspect Intelligence "hypertoy" dataset —
 * name/description/logo/gradient shown on the dataset-picker card. This is
 * NOT insight content: the illustrative INSIGHTS/TRACKED placeholder arrays
 * that used to live here were removed once the real investigation pipeline
 * (insights/services/investigation.service.js) and real tracked-metrics
 * computation (insights/services/tracked-metrics.service.js) existed — every
 * insight and tracked metric now comes from an actual computed query, never
 * from static/fake content.
 */

const META = {
  id: 'hypertoy',
  name: 'Hyper Toy',
  description: 'AI-powered business intelligence for the Hyper Toy toy retail chain — sales, profit, inventory, customers.',
  logoText: 'HT',
  gradientFrom: '#8B5CF6',
  gradientTo: '#D946EF',
};

function getMeta() {
  return META;
}

module.exports = { getMeta };
