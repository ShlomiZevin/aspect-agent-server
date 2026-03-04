/**
 * Banking Onboarder V2 - Offers Catalog
 *
 * Static product catalog for account offers.
 * The thinker uses this to match customers to the right offer.
 *
 * Edit this file to change available offers, pricing, or features.
 */

const OFFERS = [
  {
    id: 'basic',
    name: 'חשבון בסיסי',
    monthlyFee: 0,
    features: ['כרטיס חיוב', 'אפליקציית בנקאות', 'העברות בנקאיות'],
    bestFor: 'Young, first account, students, low income',
    sellingPoints: ['ללא עמלה חודשית', 'ללא יתרה מינימלית', 'פשוט ונוח']
  },
  {
    id: 'plus',
    name: 'חשבון פלוס',
    monthlyFee: 19.90,
    features: ['כרטיס אשראי', 'ביטוח בסיסי', 'מסגרת אשראי', 'שירות עדיפות'],
    bestFor: 'Salaried, moderate income, daily expenses + savings',
    sellingPoints: ['כרטיס אשראי כלול', 'ביטוח בסיסי במחיר', 'שירות עדיפות']
  },
  {
    id: 'premium',
    name: 'חשבון פרימיום',
    monthlyFee: 49.90,
    features: ['כרטיס פלטינום', 'ביטוח מורחב', 'יועץ אישי', 'הנחות מיוחדות', 'מסגרת אשראי מוגדלת'],
    bestFor: 'High income, multiple financial needs, investment-minded',
    sellingPoints: ['יועץ אישי צמוד', 'כרטיס פלטינום', 'ביטוח מורחב', 'תנאים מועדפים']
  }
];

function getOffersCatalog() {
  return OFFERS;
}

function getOfferById(id) {
  return OFFERS.find(o => o.id === id) || null;
}

module.exports = { getOffersCatalog, getOfferById };
