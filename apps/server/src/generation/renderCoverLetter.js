const { Document, Packer, Paragraph, TextRun } = require('docx');
const { tunables } = require('@careeros/shared');

// Step 2 of the 8.5 pipeline (deterministic — no AI): render the drafted body
// into a simple business-letter .docx (8.1): US Letter, 1in margins, 11pt
// throughout, no résumé header, no hyperlinks. The scaffolding blocks
// (contact/date/recipient/subject/greeting/closing) are added here; only the 4
// body paragraphs + which keywords to bold come from the model.

const pt = (n) => n * 2; // half-points
const IN = 1440; // twips/inch

function fmtToday() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// The letter body carries no emphasis at all (8.4), but a model asked for plain
// prose can still slip markdown (**bold**/__bold__) into it — strip it so no
// literal asterisks reach the .docx. This matters MORE now that nothing else
// bolds: it is the only remaining defence against stray emphasis markers.
function stripMarkdown(t) {
  return String(t).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
}

// The letter model — consumed by this renderer AND coverLetterChecks.measureOnePage.
function buildLetterModel(draft, contact, jobContext) {
  const name = contact.name || '';
  return {
    senderLines: [name, contact.cityState, contact.phone, contact.email].filter(Boolean),
    date: fmtToday(),
    recipientLines: ['Hiring Manager', jobContext.company, jobContext.location].filter(Boolean),
    subject: `Subject: Application for ${jobContext.title} - ${name}`,
    greeting: 'Dear Hiring Manager,',
    paragraphs: (draft.paragraphs || []).map(stripMarkdown),
    closingLines: ['Sincerely,', name],
  };
}

async function renderCoverLetter(model) {
  const size = pt(tunables.coverLetter.bodySizePt);
  const children = [];
  const para = (runs, afterPt = 0) => new Paragraph({ spacing: { after: afterPt * 20 }, children: runs });
  const text = (t, opts = {}) => new TextRun({ text: t, size, ...opts });

  // Sender block
  model.senderLines.forEach((l, i) => children.push(para([text(l)], i === model.senderLines.length - 1 ? 12 : 0)));
  // Date
  children.push(para([text(model.date)], 12));
  // Recipient block
  model.recipientLines.forEach((l, i) => children.push(para([text(l)], i === model.recipientLines.length - 1 ? 12 : 0)));
  // Subject + greeting. The subject line is the letter's ONLY bold text (8.1),
  // and it is deliberately not the same mechanism as the keyword bolding that
  // used to run through the body — this is a literal flag on a deterministic
  // string, not something derived from the model's output.
  children.push(para([text(model.subject, { bold: true })], 12));
  children.push(para([text(model.greeting)], 12));
  // Body — 4 paragraphs of plain prose, no emphasis of any kind (8.4).
  for (const p of model.paragraphs) children.push(para([text(p)], 10));
  // Closing
  model.closingLines.forEach((l, i) => children.push(para([text(l)], i === 0 ? 24 : 0)));

  const m = tunables.coverLetter.marginIn * IN;
  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 8.5 * IN, height: 11 * IN }, margin: { top: m, right: m, bottom: m, left: m } } }, children }],
    styles: { default: { document: { run: { font: 'Calibri' } } } },
  });
  return Packer.toBuffer(doc);
}

module.exports = { renderCoverLetter, buildLetterModel, stripMarkdown, fmtToday };
