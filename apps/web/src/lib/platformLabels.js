// Display names for company_ats_registry.platform values (spec 4.6.5).
//
// One map for the whole web app — TracklistsCard and SectorTracklistsCard each
// used to carry their own copy, and both fell behind as platforms were added.
// A platform missing here still renders, as its raw key.
export const PLATFORM_LABEL = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  workable: 'Workable',
  oracle: 'Oracle',
  eightfold: 'Eightfold AI',
  avature: 'Avature',
  apple: 'Apple',
  amazon: 'Amazon',
  google: 'Google',
  meta: 'Meta',
  phenom: 'Phenom',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  bamboohr: 'BambooHR',
  breezy: 'Breezy HR',
  rippling: 'Rippling',
  successfactors: 'SAP SuccessFactors',
  taleo: 'Oracle Taleo',
  icims: 'iCIMS',
  jibe: 'iCIMS Careers',
  radancy: 'Radancy',
  ycombinator: 'YC Work at a Startup',
};

export function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || platform;
}
