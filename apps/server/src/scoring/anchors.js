// Few-shot calibration anchors (spec 5.6).
//
// SYNTHETIC_NOT_YET_VALIDATED — these are HAND-CRAFTED examples, not real
// validated scores. Phase 1 hasn't produced any tracked outcomes yet, so per
// 5.6 we seed 3 synthetic anchors purely to give the model a concrete sense of
// what an 8.x vs a 6.x vs a sub-6 fit feels like, rather than scoring in a
// vacuum. REPLACE these with real validated examples, across a spread of
// domains, once Phase 1 tracks enough outcomes — this is the first use of the
// outcome-feedback loop.
//
// CORRECTED 2026-08-05 (spec 4.3/5.6): these were previously ERP/manufacturing
// -flavored (seeded from the founder's own personal-use Phase 1 seed data),
// which biased every strong-tier scoring call, for every user, toward that one
// domain's vocabulary. Rewritten using abstracted placeholder skills/tools
// ("Skill A", "Tool X", "Platform Y"/"Platform Z") that teach the same
// calibration PATTERN — how a years-gap, a must-have/nice-to-have split, and
// transferable-skill credit combine into a score — without asserting any real
// industry's terminology as the model's reference point.
//
// Each anchor is JD + a short résumé sketch + the correct headline judgment.
// They are injected into the strong-tier fit call (call 2) only.
const SYNTHETIC_NOT_YET_VALIDATED = true;

// RE-ANCHORED 2026-09-23 (spec 5.6): the rubric gained candidate_standing
// (the applicant pool) and the judge now reads the posting's hard
// requirements. Two anchors added for the failures a real scan showed: a
// big-employer Senior PM posting against a ~2-year APM (scored 7.9 live), and a
// required credential the candidate lacks (an "MBA required" posting scored 9.5
// live against an MS holder).
const ANCHORS = [
  {
    label: 'strong fit (~8.7)',
    jd:
      'Operations Analyst, Platform Y, mid-size company. Own Platform Y configuration for core workflow processing, partner with cross-functional teams on system integrations, build reports and dashboards using Tool X, drive change control on customizations. 3+ years relevant experience.',
    resumeSketch:
      'Precomputed candidate years 4 (gap: meets the bar). Systems Analyst (4 years, full-time): configured Platform Y for core workflow processing, built reports and dashboards in Tool X, led change-control on customizations, supported a cross-team integration project.',
    scores: {
      ats_match: 9.0,
      callback_rubric: { seniority_fit: 9, skills_evidence: 9, candidate_standing: 8, domain_fit: 9, authorization_fit: 7 },
      hard_requirements: [],
      preference_fit: 8.5,
      note: 'Direct Platform Y + Tool X + change-control overlap, and 4 years in the same function clears the 3-year bar.',
    },
  },
  {
    label: 'years bar missed (~6.6 before the years cap)',
    jd:
      'Program Manager II. Run cross-functional programs with Platform Y and Tool X, own schedules and risk registers. 5+ years of program management experience.',
    resumeSketch:
      'Precomputed candidate years 2 (gap: 3 short). Program coordinator: ran Platform Y rollouts, built Tool X trackers, owned a risk register for one program.',
    scores: {
      ats_match: 8.0,
      callback_rubric: { seniority_fit: 3, skills_evidence: 7, candidate_standing: 4, domain_fit: 8, authorization_fit: 7 },
      hard_requirements: [],
      preference_fit: 8.0,
      note: 'The tools and function line up, but a 5-year bar against 2 years is a real gap recruiters screen on.',
    },
  },
  {
    label: 'selective employer, senior title (~6.1 before the years cap)',
    jd:
      'Senior Product Manager at a large, highly selective technology company. Own the roadmap for an AI-powered platform. 5+ years of product management experience; experience influencing senior leadership.',
    resumeSketch:
      'Precomputed candidate years 3 (gap: 2 short). Associate Product Manager (1.7 years, full-time) at a small company; Business Analyst (0.4 years); product/program internships. Built AI side projects end to end.',
    scores: {
      ats_match: 7.5,
      callback_rubric: { seniority_fit: 3, skills_evidence: 5, candidate_standing: 2, domain_fit: 7, authorization_fit: 10 },
      hard_requirements: [],
      preference_fit: 9.0,
      note: 'A Senior PM bar at a heavily-applied employer against under 2 years of titled PM work — the side projects are real but will not clear the screen.',
    },
  },
  {
    label: 'required credential not held (~6.7, capped 6.4 by the knockout)',
    jd:
      'Product Manager, Operations. MBA required from a top-tier program. 4+ years in product management, operations, or consulting. Supply-chain domain knowledge.',
    resumeSketch:
      'Precomputed candidate years 3 (gap: 1 short). MS in Engineering Management (not an MBA). Supply-chain internship and an Associate PM role.',
    scores: {
      ats_match: 8.0,
      callback_rubric: { seniority_fit: 5, skills_evidence: 6, candidate_standing: 3, domain_fit: 7, authorization_fit: 7 },
      hard_requirements: [{ requirement: 'MBA', kind: 'degree', quote: 'MBA required from a top-tier program', status: 'unmet' }],
      preference_fit: 9.0,
      note: 'Domain lines up, but the posting requires an MBA and the candidate holds an MS — a knockout at the resume screen.',
    },
  },
  {
    label: 'borderline review (~6.4)',
    jd:
      'Data Analyst. Tool X + reporting on process performance and planning; nice-to-have exposure to Platform Z. 2+ years analytics experience.',
    resumeSketch:
      'Precomputed candidate years 2 (gap: meets the bar). Systems Analyst: strong Tool X and reporting background, some process-performance reporting, Platform Y (not Platform Z) experience; no formal planning-specialist title.',
    scores: {
      ats_match: 6.5,
      callback_rubric: { seniority_fit: 8, skills_evidence: 5, candidate_standing: 5, domain_fit: 6, authorization_fit: 7 },
      hard_requirements: [],
      preference_fit: 7.0,
      note: 'Reporting stack and general context line up, but the planning specialty is adjacent rather than demonstrated, and the platform is Y, not the Z named.',
    },
  },
  {
    label: 'overqualified for a support role (~6.6)',
    jd:
      'Project Assistant, engineering firm. Maintain project logs and trackers, prepare meeting minutes, coordinate document control and client billing, schedule meetings. 1+ years administrative experience; Tool X required.',
    resumeSketch:
      'Precomputed candidate years 3 (gap: meets the bar). Posting level (precomputed): an assistant/administrative support role. Program Manager and Systems Analyst: ran cross-functional programs, built trackers and dashboards in Tool X; no administrative or billing role.',
    scores: {
      ats_match: 7.5,
      callback_rubric: { seniority_fit: 5, skills_evidence: 7, candidate_standing: 6, domain_fit: 5, authorization_fit: 7 },
      hard_requirements: [],
      preference_fit: 9.0,
      note: 'Can do every task listed, but a program manager applying for an assistant role reads as overqualified and likely to leave, which is how screeners usually treat it.',
    },
  },
  {
    label: 'weak fit (~3.1, archived)',
    jd:
      'Senior Finance Manager. Own the annual budgeting cycle, financial modeling, board reporting, and lead a team of analysts. 8+ years finance experience, CPA preferred.',
    resumeSketch:
      'Precomputed candidate years 2 (gap: 6 short). Systems Analyst: Platform Y configuration and operational reporting; no finance, budgeting, financial-modeling, or people-management experience.',
    scores: {
      ats_match: 4.0,
      callback_rubric: { seniority_fit: 1, skills_evidence: 2, candidate_standing: 1, domain_fit: 2, authorization_fit: 7 },
      hard_requirements: [],
      preference_fit: 6.0,
      note: 'Off-domain (finance vs systems analysis), an 8-year seniority bar against ~2 years, and no financial-modeling or leadership evidence.',
    },
  },
];

module.exports = { ANCHORS, SYNTHETIC_NOT_YET_VALIDATED };
