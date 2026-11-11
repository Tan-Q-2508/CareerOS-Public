import { verdictClass } from '../lib/display';

const LABEL = { pursue: 'Pursue', review: 'Review', pass: 'Pass' };

// The signature "verdict stamp" (spec Section 3 / 5.2).
export default function VerdictStamp({ verdict }) {
  const cls = verdictClass(verdict);
  return <span className={`stamp ${cls}`}>{LABEL[cls] || 'Pass'}</span>;
}
