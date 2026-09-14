import type { Annotation, AnnotationCandidate } from './types';

export const terminationContractDemoFileName = 'fictional-termination-contract.pdf';
export const terminationContractDemoPrompt = 'Find every termination clause, classify it as High / Medium / Low risk, highlight the evidence, and ask me when the wording is uncertain.';

export const terminationContractDemoGuidelines = 'Fictional offline demonstration only. Preset labels illustrate the review workflow and are not legal advice or model output. High: one-sided termination rights, especially immediate rights or rights tied to an undefined performance test, and uncapped exposure. Medium: a mutual right tied to an event that should be checked against the agreement context, or another important operational term that is unclear. Low: a mutual, bounded right with a stated notice or cure period. Keep a short exact excerpt. Leave undefined terms or missing notice periods in human review; do not infer a legal meaning.';

export const terminationContractDemoAnnotations: Annotation[] = [
  {
    id: 'termination-demo-8-1', pageNumber: 1, x: 0.176, y: 0.288, width: 0.735, height: 0.12,
    label: 'LOW RISK · 8.1', note: 'Preset sample label: either party has the same right and a stated 30-day notice period.',
    reason: 'This fixed demonstration label follows the displayed guideline; no model was run.',
    excerpt: 'Either party may terminate this Agreement for convenience by giving the other party thirty (30) days written notice.',
    color: '#178b87', source: 'demo', reviewPriority: 'low',
  },
  {
    id: 'termination-demo-8-2', pageNumber: 1, x: 0.176, y: 0.44, width: 0.735, height: 0.14,
    label: 'HIGH RISK · 8.2', note: 'Preset sample label: Customer alone may end the agreement immediately and without cause.',
    reason: 'This fixed demonstration label illustrates a broad one-sided termination right.',
    excerpt: 'Customer may terminate this Agreement at any time, with or without cause, effective immediately upon written notice.',
    color: '#d36c74', source: 'demo', reviewPriority: 'medium',
  },
  {
    id: 'termination-demo-8-3', pageNumber: 1, x: 0.176, y: 0.61, width: 0.735, height: 0.13,
    label: 'LOW RISK · 8.3', note: 'Preset sample label: mutual termination requires written notice and a 20-day cure period.',
    reason: 'This fixed demonstration label illustrates a bounded right with a stated cure period.',
    excerpt: 'does not cure that breach within twenty (20) days after receiving written notice',
    color: '#557ec2', source: 'demo', reviewPriority: 'low',
  },
  {
    id: 'termination-demo-8-4', pageNumber: 2, x: 0.176, y: 0.22, width: 0.735, height: 0.15,
    label: 'MEDIUM RISK · 8.4', note: 'Preset sample label: insolvency triggers are listed, with a 60-day dismissal window.',
    reason: 'This fixed demonstration label asks the reviewer to consider the stated trigger and timeline.',
    excerpt: 'a proceeding that is not dismissed within sixty (60) days',
    color: '#9275d3', source: 'demo', reviewPriority: 'low',
  },
  {
    id: 'termination-demo-8-5', pageNumber: 2, x: 0.176, y: 0.39, width: 0.735, height: 0.15,
    label: 'HIGH RISK · 8.5', note: 'Preset sample label: the target and measurement method are not specified in this section.',
    reason: 'This fixed demonstration label highlights operational terms that are missing from the clause.',
    excerpt: 'The target, measurement method, and notice period are not specified in this section.',
    color: '#d36c74', source: 'demo', reviewPriority: 'medium',
  },
];

export const terminationContractDemoCandidate: AnnotationCandidate = {
  id: 'termination-demo-8-6-ambiguous', pageNumber: 2,
  x: 0.176, y: 0.565, width: 0.735, height: 0.155,
  label: 'MEDIUM RISK? · 8.6',
  note: 'Scripted suggestion left for your review. “Reasonable business circumstances” is not defined, and there is no advance notice period.',
  reason: 'The contract leaves both the trigger and notice timing open. The sample deliberately asks a human instead of presenting a confident classification.',
  excerpt: 'Either party may terminate this Agreement for reasonable business circumstances.',
  color: '#e8a532', source: 'demo', reviewPriority: 'medium', requiresReview: true,
};
