const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendLybiContactEmail({ name, email, company, message }) {
  const recipients = 'noa@freeda.ai, noa@lybi.ai';

  const text = [
    `New contact form submission from Lybi landing page`,
    ``,
    `Name:    ${name}`,
    `Email:   ${email}`,
    `Company: ${company || '—'}`,
    `Message: ${message || '—'}`,
  ].join('\n');

  await transporter.sendMail({
    from: `"Lybi Contact" <${process.env.GMAIL_USER}>`,
    to: recipients,
    subject: `New contact: ${name}`,
    text,
  });
}

module.exports = { sendLybiContactEmail };
