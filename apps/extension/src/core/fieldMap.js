// fieldMap.js — the field-name synonym map the DOM label matcher scores
// against (spec §15 session 28: "fuzzy match against a field-name synonym
// map"). Platform-agnostic on purpose: every ATS asks for the same handful of
// standard fields under slightly different labels, so the adapters
// (src/adapters/*.js) only supply DOM shape, never field semantics.
//
// Each entry:
//   key      — the profile key the value comes from (see profileValue()).
//   aliases  — normalized label phrasings that mean this field. Matched by
//              exact-or-contains against the field's normalized label.
//   exclude  — normalized phrases that DISQUALIFY a label even if an alias
//              hit, to stop near-miss collisions (e.g. "company website" is
//              the employer's site, not the candidate's personal site).
//   strict   — aliases from this field's list that only count on an EXACT
//              normalized match. These are the one-word, high-collision
//              aliases ("name", "title", "company", "address"): allowing them
//              to match by containment made "what is the name of the person
//              who referred you" look like a full-name field. Anything broad
//              enough to appear mid-sentence in an unrelated question belongs
//              here.
//   type     — expected input type, used to skip obviously wrong controls.
//
// Order matters: MATCH_FIELDS is scanned top to bottom and the first field
// whose alias set matches wins, so narrower fields (first/last name) are
// listed before broader ones (name).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CareerOSAutofillFieldMap = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MATCH_FIELDS = [
    {
      key: 'firstName',
      aliases: ['first name', 'given name', 'forename', 'legal first name', 'preferred first name'],
      exclude: [],
      type: 'text',
    },
    {
      key: 'lastName',
      aliases: ['last name', 'surname', 'family name', 'legal last name'],
      exclude: [],
      type: 'text',
    },
    {
      key: 'fullName',
      strict: ['name', 'your name'],
      aliases: ['full name', 'name', 'your name', 'legal name', 'candidate name', 'applicant name'],
      // "name" is broad enough to hit almost anything — everything that is a
      // DIFFERENT question containing the word "name" is excluded here.
      exclude: [
        'first', 'last', 'user', 'company', 'school', 'university', 'file',
        'refer', 'manager', 'employer', 'pronoun', 'preferred name',
      ],
      type: 'text',
    },
    {
      key: 'email',
      strict: ['email'],
      aliases: ['email', 'e mail', 'email address', 'your email'],
      exclude: ['refer', 'manager', 'confirm'],
      type: 'email',
    },
    {
      key: 'phone',
      strict: ['phone', 'mobile', 'cell'],
      aliases: ['phone', 'phone number', 'mobile', 'mobile number', 'mobile phone', 'cell', 'cell phone', 'telephone', 'contact number'],
      exclude: ['refer', 'emergency'],
      type: 'tel',
    },
    {
      key: 'location',
      strict: ['address'],
      aliases: ['location', 'city', 'current location', 'city state', 'where are you located', 'city and state', 'address'],
      exclude: ['relocate', 'willing', 'preferred location', 'work location', 'office'],
      type: 'text',
    },
    {
      key: 'linkedin',
      aliases: ['linkedin', 'linkedin profile', 'linkedin url', 'linked in'],
      exclude: [],
      type: 'url',
    },
    {
      key: 'github',
      aliases: ['github', 'github profile', 'github url', 'git hub'],
      exclude: [],
      type: 'url',
    },
    {
      key: 'gitlab',
      aliases: ['gitlab', 'gitlab profile', 'gitlab url', 'git lab'],
      exclude: [],
      type: 'url',
    },
    {
      key: 'twitter',
      aliases: ['twitter', 'twitter profile', 'twitter url', 'twitter handle', 'x (twitter)', 'x/twitter'],
      exclude: ['company', 'employer'],
      type: 'url',
    },
    {
      key: 'portfolio',
      strict: ['website', 'web site', 'portfolio'],
      aliases: ['portfolio', 'portfolio url', 'personal website', 'website', 'personal site', 'web site', 'other website'],
      exclude: ['company', 'employer', 'linkedin', 'github', 'gitlab', 'twitter'],
      type: 'url',
    },
    {
      key: 'currentCompany',
      strict: ['company', 'employer'],
      aliases: ['current company', 'company', 'current employer', 'employer', 'most recent company', 'current organization'],
      exclude: ['website', 'url', 'why', 'size', 'refer'],
      type: 'text',
    },
    {
      key: 'currentTitle',
      strict: ['title'],
      aliases: ['current title', 'job title', 'current job title', 'current role', 'most recent title', 'title'],
      exclude: ['job you are applying', 'position applying'],
      type: 'text',
    },
    {
      key: 'school',
      strict: ['school', 'university', 'college', 'institution'],
      aliases: ['school', 'university', 'college', 'institution', 'alma mater'],
      exclude: ['high school'],
      type: 'text',
    },
    {
      key: 'degree',
      strict: ['degree'],
      aliases: ['degree', 'highest degree', 'level of education', 'education level'],
      exclude: [],
      type: 'text',
    },
    {
      key: 'yearsOfExperience',
      strict: ['years of experience', 'years experience', 'how many years of experience'],
      aliases: ['years of experience', 'total years of experience', 'how many years of experience', 'years experience', 'total years experience'],
      exclude: [],
      type: 'number',
    },
    {
      key: 'resumeFile',
      strict: ['resume', 'cv'],
      aliases: ['resume', 'cv', 'resume cv', 'upload resume', 'attach resume', 'resume upload'],
      exclude: ['cover letter'],
      type: 'file',
    },
  ];

  return { MATCH_FIELDS };
});
