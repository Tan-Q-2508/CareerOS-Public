const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  Tab,
  TabStopType,
  AlignmentType,
  BorderStyle,
  LineRuleType,
} = require('docx');
const { buildContactLine } = require('./extractContact');
const { orderLinks, labelForLink } = require('@careeros/shared');
const { SIZE, SPACE, geometry, DEFAULT_RENDER, SKILL_SEP, packSkillRows } = require('./metrics');

// Step 2 of the 7.12 pipeline (deterministic — no AI): render the drafted
// content into a .docx implementing the LOCKED formatting (7.1-7.10). Titles,
// companies, dates and education come from the parsed profile, never the AI, so
// they can't be retitled (7.5) or fabricated (7.9).
//
// The render options (margins, line spacing, header scale, inter-element
// spacing) are chosen by fitToPage to fill/fit the page; they're applied here
// exactly as metrics.measureLayout measured them.

const pt = (n) => n * 2; // docx font sizes are half-points
const twip = (ptVal) => Math.round(ptVal * 20); // 1pt = 20 twips
const IN = 1440; // twips per inch

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtYm(s) {
  if (!s) return '';
  if (/present|current/i.test(s)) return 'Present';
  const m = String(s).match(/(\d{4})-(\d{1,2})/);
  if (!m) return String(s);
  return `${MONTHS[Math.min(11, Math.max(0, Number(m[2]) - 1))]} ${m[1]}`;
}
function fmtDates(dates) {
  if (!dates) return '';
  const start = fmtYm(dates.start);
  const end = fmtYm(dates.end) || 'Present';
  return start ? `${start} – ${end}` : end;
}
// Whole-month span of a {start,end} range ('present' → today). Used to mark
// short internships (the only droppable roles) so the fit trimmer can shed them
// before touching projects (7.5/7.8).
function monthsBetween(dates) {
  if (!dates || !dates.start) return null;
  const parse = (s) => {
    const m = String(s).match(/(\d{4})-(\d{1,2})/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const start = parse(dates.start);
  if (!start) return null;
  let end;
  if (!dates.end || /present|current/i.test(String(dates.end))) {
    const d = new Date();
    end = [d.getFullYear(), d.getMonth() + 1];
  } else {
    end = parse(dates.end);
  }
  if (!end) return null;
  return (end[0] - start[0]) * 12 + (end[1] - start[1]);
}
function isOngoing(dates) {
  return !dates || !dates.end || /present|current/i.test(String(dates.end));
}

// Split an education entry into a BOLD "Degree, Field" part and a regular
// institution part (7.9). Dedupes a field already inside the degree text.
function eduParts(e) {
  const degree = (e.degree || '').trim();
  const field = (e.field || '').trim();
  const degreeField =
    field && !degree.toLowerCase().includes(field.toLowerCase())
      ? [degree, field].filter(Boolean).join(', ')
      : degree;
  return { degreeField, institution: (e.institution || '').trim(), location: (e.location || '').trim() };
}
function eduLine(e) {
  const { degreeField, institution, location } = eduParts(e);
  const inst = [institution, location].filter(Boolean).join(', ');
  return [degreeField, inst].filter(Boolean).join(' — ');
}

// The layout model consumed by BOTH this renderer and metrics.measureLayout.
function buildLayoutModel(draft, profile, contact) {
  const roles = profile.roles || [];
  const projects = profile.projects || [];

  const experience = [...(draft.experience || [])]
    .sort((a, b) => a.role_index - b.role_index)
    .map((g) => {
      const role = roles[g.role_index] || {};
      const months = monthsBetween(role.dates);
      return {
        title: role.title || '',
        company: role.company || '',
        dates: fmtDates(role.dates),
        // Only a COMPLETED <=3-month internship may be dropped by the fit trimmer
        // — never the current/ongoing role, however short so far (7.5).
        droppable: !isOngoing(role.dates) && months != null && months <= 3 && /intern/i.test(role.title || ''),
        bullets: (g.bullets || []).map((b) => b.text),
      };
    })
    // A shown role needs at least 1 bullet (was 2). Full-time / >3-month roles
    // must always appear even with a single bullet, to avoid an unexplained
    // employment gap (7.5, updated 2026-07-20) — the drafter gives weak roles
    // fewer bullets rather than dropping them.
    .filter((r) => r.bullets.length >= 1);

  const projOut = (draft.projects || [])
    .map((g) => {
      const proj = projects[g.project_index] || {};
      return { title: proj.title || '', dates: fmtDates(proj.dates), bullets: (g.bullets || []).map((b) => b.text) };
    })
    .filter((p) => p.bullets.length >= 1);

  const skillRows = [
    { label: 'Technical', items: draft.skills.technical },
    { label: 'Management', items: draft.skills.management },
    { label: 'Business', items: draft.skills.business },
    { label: 'Certifications', items: draft.skills.certifications },
  ].filter((r) => r.items && r.items.length);

  return {
    header: { name: contact.name || '', title: draft.professional_title, contactLine: buildContactLine(contact), contact },
    summary: draft.summary_bullets || [],
    experience,
    projects: projOut,
    education: (profile.education || [])
      .map((e) => { const p = eduParts(e); return { degreeField: p.degreeField, institution: p.institution, dates: fmtDates(e.dates) }; })
      .filter((e) => e.degreeField || e.institution),
    skills: skillRows,
  };
}

// --- docx paragraph builders (LOCKED formatting) ---
// `o` = the render options; all vertical spacing comes from the shared
// metrics.SPACE constants and the same line-spacing/header-scale knobs the
// measurement used, so the produced .docx matches what was measured.

function renderResume(model, opts = {}) {
  const o = { ...DEFAULT_RENDER, ...opts };
  const usableW = geometry(o.marginIn).usableW;
  const lineSpacing = { line: Math.round(240 * o.lineSpacing), lineRule: LineRuleType.AUTO };
  const after = (ptVal) => twip(ptVal * o.spacingScale);
  const hSize = (s) => pt(s * o.headerScale);

  const centered = (children, afterPt) =>
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: after(afterPt), ...lineSpacing }, children });

  const contactChildren = (contact) => {
    const parts = [];
    const push = (val, href) => {
      if (!val) return;
      if (parts.length) parts.push(new TextRun({ text: ' | ', size: pt(SIZE.contact) }));
      if (href) {
        const link = /^https?:\/\//i.test(href) ? href : `https://${href}`;
        parts.push(new ExternalHyperlink({ link, children: [new TextRun({ text: val, size: pt(SIZE.contact), style: 'Hyperlink' })] }));
      } else parts.push(new TextRun({ text: val, size: pt(SIZE.contact) }));
    };
    push(contact.cityState); push(contact.phone); push(contact.email);
    // Each recognised link (7.2) shows its platform LABEL (not the raw URL) as
    // clickable hyperlink text, in registry order. `contact.links` is already
    // trimmed to what fits the 2-line contact line (metrics.fitContactLinks,
    // applied in buildModelFrom).
    for (const l of orderLinks(contact.links || [])) push(labelForLink(l), l.url);
    return parts.length ? parts : [new TextRun({ text: '', size: pt(SIZE.contact) })];
  };

  const sectionHeader = (text) =>
    new Paragraph({
      spacing: { before: after(SPACE.sectionHeaderBefore), after: after(SPACE.sectionHeaderAfter), ...lineSpacing },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: '000000' } },
      children: [new TextRun({ text: text.toUpperCase(), bold: true, size: hSize(SIZE.sectionHeader) })],
    });

  const bullet = (text, afterPt = SPACE.afterBullet) =>
    new Paragraph({
      indent: { left: twip(SIZE.bullet + 2), hanging: twip(SIZE.bullet + 2) },
      spacing: { after: after(afterPt), ...lineSpacing },
      children: [new TextRun({ text: '•  ', size: pt(SIZE.bullet) }), new TextRun({ text, size: pt(SIZE.bullet) })],
    });

  const roleHeader = (title, company, dates) => {
    const left = company ? `${title} — ${company}` : title;
    return new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: twip(usableW) }],
      spacing: { after: after(SPACE.afterRoleHeader), ...lineSpacing },
      children: [
        new TextRun({ text: left, bold: true, size: pt(SIZE.roleTitle) }),
        new TextRun({ children: [new Tab()] }),
        new TextRun({ text: dates, bold: true, size: pt(SIZE.roleDates) }),
      ],
    });
  };

  const bulletBlock = (children, bullets, blockGapPt) => {
    bullets.forEach((b, i) => {
      const isLast = i === bullets.length - 1;
      children.push(bullet(b, isLast ? SPACE.afterBullet + blockGapPt : SPACE.afterBullet));
    });
  };

  const children = [];
  children.push(centered([new TextRun({ text: model.header.name, bold: true, size: hSize(SIZE.name) })], SPACE.afterName));
  children.push(centered([new TextRun({ text: model.header.title, bold: true, size: hSize(SIZE.title) })], SPACE.afterTitle));
  children.push(centered(contactChildren(model.header.contact), SPACE.afterContact));

  children.push(sectionHeader('Professional Summary'));
  for (const b of model.summary) children.push(bullet(b));

  children.push(sectionHeader('Work Experience'));
  for (const role of model.experience) {
    children.push(roleHeader(role.title, role.company, role.dates));
    bulletBlock(children, role.bullets, SPACE.afterRoleBlock);
  }

  if (model.projects.length) {
    children.push(sectionHeader('Relevant Projects'));
    for (const proj of model.projects) {
      children.push(roleHeader(proj.title, '', proj.dates || ''));
      bulletBlock(children, proj.bullets, SPACE.afterProjectBlock);
    }
  }

  children.push(sectionHeader('Education'));
  for (const e of model.education) {
    // Degree + major BOLD; institution regular; dates BOLD + right-aligned
    // (matches the role/project date styling — 7.9).
    const runs = [];
    if (e.degreeField) runs.push(new TextRun({ text: e.degreeField, bold: true, size: pt(SIZE.education) }));
    if (e.institution) runs.push(new TextRun({ text: `${e.degreeField ? ' — ' : ''}${e.institution}`, size: pt(SIZE.education) }));
    if (e.dates) runs.push(new TextRun({ children: [new Tab()] }), new TextRun({ text: e.dates, bold: true, size: pt(SIZE.education) }));
    children.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: twip(usableW) }],
      spacing: { after: after(SPACE.afterEducationLine), ...lineSpacing },
      children: runs,
    }));
  }

  children.push(sectionHeader('Skills & Certifications'));
  // Packed onto as few physical lines as possible (7.10, 2026-07-28) — a
  // short row shares a line with its neighbor rather than eating a whole
  // line's height on its own. Grouping comes from the SAME packSkillRows
  // measureLayout uses against the same usableW, so the .docx can never
  // disagree with what fitToPage measured.
  const skillGroups = packSkillRows(model.skills, usableW);
  for (const group of skillGroups) {
    const runs = [];
    group.rowIndexes.forEach((idx, i) => {
      const row = model.skills[idx];
      if (i > 0) runs.push(new TextRun({ text: SKILL_SEP, size: pt(SIZE.skillsBody) }));
      runs.push(new TextRun({ text: `${row.label}: `, bold: true, size: pt(SIZE.skillsLabel) }));
      runs.push(new TextRun({ text: row.items.join(', '), size: pt(SIZE.skillsBody) }));
    });
    children.push(new Paragraph({
      spacing: { after: after(SPACE.afterSkillRow), ...lineSpacing },
      children: runs,
    }));
  }

  const m = o.marginIn * IN;
  const doc = new Document({
    sections: [{ properties: { page: { size: { width: 8.5 * IN, height: 11 * IN }, margin: { top: m, right: m, bottom: m, left: m } } }, children }],
    styles: { default: { document: { run: { font: 'Calibri' } } } },
  });
  return Packer.toBuffer(doc);
}

module.exports = { renderResume, buildLayoutModel, fmtDates, eduLine, eduParts };
