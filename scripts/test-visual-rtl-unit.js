/**
 * visualToLogical — offline, no DB.
 *
 * Every input below is a real TheStock item description as delivered (visual
 * order, wrapped in U+202D … U+202C); expected outputs were checked by eye
 * against the Hebrew they obviously spell. See scripts/lib/visual-rtl.js.
 *
 * Usage: node scripts/test-visual-rtl-unit.js
 */
const { visualToLogical } = require('./lib/visual-rtl');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `\n       got:      ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`}`);
}
const V = s => `‭${s}‬`;

console.log('\nvisualToLogical ────────────────────────────────────────');
check('plain Hebrew', visualToLogical(V('יללכ רצומ')), 'מוצר כללי');
check('single word', visualToLogical(V('יוכיז')), 'זיכוי');
check('decimal number keeps its digits in order',
  visualToLogical(V('תכתמ רטמ 1.50 אטאטמ לקמ')), 'מקל מטאטא 1.50 מטר מתכת');
check('brackets are mirrored back, quote and number kept',
  visualToLogical(V('ל"מ 100 - (תששע ינפמ תילמיסקמ הנגה) םודא טייגלוק')),
  'קולגייט אדום (הגנה מקסימלית מפני עששת) - 100 מ"ל');
check('a Latin phrase with trailing size stays one left-to-right run',
  visualToLogical(V('HAV. KIDS TOP PJ MASKS BLUE WATER 31/32 סנאיווה')),
  'הוויאנס HAV. KIDS TOP PJ MASKS BLUE WATER 31/32');
check('Latin words inside Hebrew keep their order',
  visualToLogical(V('Cameo Glam חי 100 ןבל/רוחש רעישל ןוקיליס תוימוג')),
  'גומיות סיליקון לשיער שחור/לבן 100 יח Cameo Glam');
check('two bare numbers after a Hebrew word stay separate runs',
  visualToLogical(V('blue םיעבצ 3 23225 םישנ האישנ קית')),
  'תיק נשיאה נשים 23225 3 צבעים blue');
check('alphanumeric code', visualToLogical(V('ינכמ M16 הבור')), 'רובה M16 מכני');

console.log('\nidempotence / scope ────────────────────────────────────');
check('text without the override marker is returned unchanged', visualToLogical('מוצר כללי'), 'מוצר כללי');
check('a converted value converts to itself', visualToLogical(visualToLogical(V('יללכ רצומ'))), 'מוצר כללי');
check('empty string', visualToLogical(''), '');
check('null passes through', visualToLogical(null), null);
check('no directional marks survive', /[‪-‮]/.test(visualToLogical(V('יללכ רצומ'))), false);

console.log(`\n════════ ${pass}/${pass + fail} PASS ════════`);
process.exit(fail ? 1 : 0);
