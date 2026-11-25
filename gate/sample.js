/**
 * Invented sample records for Lybi Gate — account-opening leads of foreign
 * caregivers (EasyWay). Seeded, so the same list every time. IDs, cards and
 * IBANs only have valid check digits; none belongs to anyone.
 * The keys are the bank system's own field names — the same ones the inbound
 * API uses — so a sample file and an API call land on the same policy.
 */

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sampleRecords() {
  const R = rng(20261125);
  const digits = n => Array.from({ length: n }, () => Math.floor(R() * 10)).join('');
  const ilId = () => { const b = String(1 + Math.floor(R() * 9)) + digits(7); let s = 0; for (let i = 0; i < 8; i++) { let v = Number(b[i]) * (i % 2 ? 2 : 1); if (v > 9) v -= 9; s += v; } return b + ((10 - (s % 10)) % 10); };
  const card = () => { const b = `4580${digits(11)}`; let s = 0; let dbl = true; for (let i = b.length - 1; i >= 0; i--) { let v = Number(b[i]); if (dbl) { v *= 2; if (v > 9) v -= 9; } s += v; dbl = !dbl; } return (b + ((10 - (s % 10)) % 10)).match(/.{4}/g).join(' '); };
  const iban = () => { const bban = `054${digits(3)}${digits(13)}`; const num = `${bban}IL00`.replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55)); let r = 0; for (const d of num) r = (r * 10 + Number(d)) % 97; return `IL${String(98 - r).padStart(2, '0')}${bban}`.match(/.{1,4}/g).join(' '); };
  const phone = () => `05${'02348'[Math.floor(R() * 5)]}-${digits(7)}`;
  const people = [
    ['Maria Santos Reyes', 'maria.s', 'הפיליפינים', 'טגלוג, אנגלית', '1989-03-14', 7450, 'רחוב הרצל 12, חיפה'],
    ['Ravi Kumar Nair', 'ravi.k', 'הודו', 'הינדי, אנגלית', '1984-11-02', 6900, 'שדרות ירושלים 40, בת ים'],
    ['Nimali Perera', 'nimali.p', 'סרי לנקה', 'סינהלה', '1991-07-27', 6250, 'רחוב הנביאים 8, ירושלים'],
    ['Elena Rusu', 'elena.r', 'מולדובה', 'רומנית, רוסית', '1979-01-09', 8100, 'רחוב ויצמן 3, כפר סבא'],
    ['Joy Dela Cruz', 'joy.d', 'הפיליפינים', 'טגלוג', '1995-05-30', 5800, 'רחוב סוקולוב 21, חולון'],
    ['Thi Lan Nguyen', 'lan.n', 'וייטנאם', 'וייטנאמית', '1987-09-18', 9300, 'רחוב הגפן 5, נתניה'],
  ];
  const employers = ['סיעוד פלוס בע״מ', 'יד ביד שירותי סיעוד', 'אופק סיעוד'];
  return people.map((p, i) => {
    const pass = digits(8); const ph2 = phone();
    return {
      leadId: `EW-${24180 + i * 7}`,
      fullName: p[0],
      passportNumber: pass,
      birthDate: p[4],
      phone: phone(),
      email: `${p[1]}@example.com`,
      address: p[6],
      country: p[2],
      language: p[3],
      monthlyIncome: String(p[5]),
      employer: employers[i % 3],
      patientId: ilId(),
      iban: iban(),
      existingCard: card(),
      agentNotes: i % 2 === 0
        ? `ביקשה שנחזור אליה ב־${ph2} אחרי 17:00. דרכון ${pass} בתוקף עד 2028.`
        : `שאל אם אפשר להעביר משכורת לחשבון. השאיר מספר נוסף ${ph2}.`,
    };
  });
}

module.exports = { sampleRecords };
