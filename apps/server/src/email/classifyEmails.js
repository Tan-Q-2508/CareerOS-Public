const aiRouter = require('../lib/aiRouter');

// Single batched AI classification call (spec §9.1.3): every candidate email plus
// the list of in-scope applications goes to the model in ONE call. For each email
// it returns which application it matches (or none), the signal type, and any
// concrete detail (e.g. an interview date). Cheap tier — this is mechanical
// matching + light categorization, the same tier as the JD/ATS extraction call.
//
// The shared "list of active applications" is placed FIRST as a stable prefix so
// it's naturally prompt-cacheable across the emails within the batch (§9.1.3).

const SIGNAL_TYPES = ['application_confirmation', 'rejection', 'interview_scheduling', 'recruiter_followup', 'offer', 'ambiguous', 'unrelated'];

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          email_id: { type: 'string' },
          matched_application_id: { type: 'string', nullable: true },
          candidate_application_ids: { type: 'array', items: { type: 'string' }, nullable: true },
          signal_type: { type: 'string', enum: SIGNAL_TYPES },
          interview_date: { type: 'string', nullable: true },
          interview_round: { type: 'string', nullable: true },
          detail: { type: 'string', nullable: true },
        },
        required: ['email_id', 'matched_application_id', 'candidate_application_ids', 'signal_type', 'interview_date', 'interview_round', 'detail'],
      },
    },
  },
  required: ['results'],
};

const SYSTEM_INSTRUCTION = [
  'You classify job-search emails against a list of the user\'s active job applications.',
  'You are given (a) a list of applications, each with an id, company, job title, and current tracker stage, and (b) a batch of candidate emails (id, sender, subject, date, and body text).',
  'Base your classification on the actual body text, not just the subject or an opening pleasantry — a rejection template routinely opens with "thanks for applying" before the real decision a sentence or two later; do not classify an email as application_confirmation just because it starts politely.',
  'For EACH email, decide:',
  '- matched_application_id: the id of the SPECIFIC application this email is about, or null if it names no specific role (see candidate_application_ids below) or matches none of them (or is unrelated to any job search). Only use an id that appears in the provided application list — never invent one.',
  '- candidate_application_ids: bug fix 2026-07-28 — some real confirmation emails (e.g. a generic "Thanks for applying to Google" with no job title, subject, or req number anywhere in it) genuinely cannot be tied to one specific application when the user has several open applications at that company. Do NOT guess by picking whichever one happens to be "most recent" or already Applied — that produces a wrong, confident-looking answer that silently overwrites the wrong job\'s status. Instead: if the email is clearly from/about a company but names no specific role, set matched_application_id to null and set candidate_application_ids to the ids of EVERY application at that company for which this signal would be a plausible update (i.e. still eligible for the stage move — e.g. an application_confirmation only makes sense for one still Saved). If the email does name a specific role (or the user has only one open application at that company), set matched_application_id normally and leave candidate_application_ids null.',
  '- signal_type: one of application_confirmation, rejection, interview_scheduling, recruiter_followup, offer, ambiguous, unrelated.',
  '    application_confirmation = an acknowledgement that the application was received/submitted, with no decision yet (e.g. "Thanks for applying", "We received your application").',
  '    rejection = the application was declined/not moving forward.',
  '    interview_scheduling = an interview is being scheduled or confirmed (phone/onsite/technical), for ANY round.',
  '    offer = a job offer is extended.',
  '    recruiter_followup = a recruiter is reaching out or following up but no decision/interview yet.',
  '    ambiguous = clearly about a tracked application but the outcome is unclear.',
  '    unrelated = not about any tracked application (newsletters, job alerts, unrelated mail). Use matched_application_id null for these.',
  '- interview_date: if (and only if) the email states a concrete interview date/time, return it as an ISO-8601 date (YYYY-MM-DD) or datetime; otherwise null.',
  '- interview_round: if the email indicates which interview round/stage it is, note it briefly (e.g. "Round 2", "Final", "Technical", "Hiring manager"); otherwise null. Optional — the round never changes the signal_type, it is only a note.',
  '- detail: one short phrase capturing the concrete signal (e.g. "Interview scheduled for July 22", "Position filled", "Application received"), or null.',
  'Be conservative: if an email does not clearly correspond to one of the listed applications, set matched_application_id null and signal_type unrelated. Do not force a match.',
  'Return strict JSON matching the schema, with exactly one result object per input email.',
].join('\n');

function makeValidator(applicationIds, emailIds) {
  const appSet = new Set(applicationIds);
  const emailSet = new Set(emailIds);
  return function validate(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.results)) return 'results must be an array';
    for (const r of p.results) {
      if (!r || typeof r !== 'object') return 'each result must be an object';
      if (typeof r.email_id !== 'string' || !emailSet.has(r.email_id)) {
        return `result.email_id "${r.email_id}" is not one of the input emails`;
      }
      if (!SIGNAL_TYPES.includes(r.signal_type)) {
        return `result.signal_type "${r.signal_type}" is invalid`;
      }
      // Grounding: a matched id must be a real application id (or null).
      if (r.matched_application_id != null && !appSet.has(r.matched_application_id)) {
        return `result.matched_application_id "${r.matched_application_id}" is not a known application id`;
      }
      // Same grounding rule for the clarify-list ids (2026-07-28).
      if (r.candidate_application_ids != null) {
        if (!Array.isArray(r.candidate_application_ids)) {
          return 'result.candidate_application_ids must be an array or null';
        }
        for (const id of r.candidate_application_ids) {
          if (!appSet.has(id)) return `result.candidate_application_ids contains unknown id "${id}"`;
        }
      }
    }
    return null;
  };
}

function applicationsBlock(applications) {
  const lines = applications.map(
    (a) => `- id=${a.id} | company=${a.company || '(unknown)'} | title=${a.title || '(unknown)'} | current_stage=${a.stage}`
  );
  return ['ACTIVE APPLICATIONS (fixed context for this batch):', ...lines].join('\n');
}

function emailsBlock(emails) {
  return [
    'CANDIDATE EMAILS TO CLASSIFY:',
    ...emails.map((e, i) =>
      [
        `EMAIL ${i + 1}`,
        `id: ${e.id}`,
        `from: ${e.from || '(none)'}`,
        `subject: ${e.subject || '(none)'}`,
        `date: ${e.date || '(none)'}`,
        `body: ${e.body || e.snippet || '(none)'}`,
      ].join('\n')
    ),
  ].join('\n\n');
}

/**
 * @param {Array<{id,company,title,stage}>} applications
 * @param {Array<{id,from,subject,body,date}>} emails
 * @returns {{ results, usage, costUsd, model, connectionMode }}
 */
async function classifyEmails({ applications, emails, credential }) {
  const prompt = `${applicationsBlock(applications)}\n\n---\n\n${emailsBlock(emails)}`;
  const validate = makeValidator(
    applications.map((a) => a.id),
    emails.map((e) => e.id)
  );
  const result = await aiRouter.structuredCall(credential, {
    tier: 'cheap',
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt,
    responseSchema: CLASSIFY_SCHEMA,
    validate,
  });
  return {
    results: result.parsed.results,
    usage: result.usage,
    costUsd: result.costUsd,
    model: result.model,
    connectionMode: result.connectionMode,
    tier: 'cheap',
  };
}

module.exports = { classifyEmails, makeValidator, SIGNAL_TYPES, CLASSIFY_SCHEMA };
