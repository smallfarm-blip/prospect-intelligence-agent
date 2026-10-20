import type { Tone } from '@/components/ui';
import type { AssessmentLevel, Confidence, DiscoverySegment, FitStatus, NextActionKey, OverrideField, ProspectDecisionKind } from '@/lib/prospectTypes';
import type { Queue, ReviewState } from '@/lib/prospectView';

export const QUEUE_META: Record<Queue, { label: string; tone: Tone; hint: string }> = {
  verified_fit: { label: 'Verified fit', tone: 'success', hint: 'Category, direct selling, country and revenue are independently verified' },
  probable_fit: { label: 'Probable fit', tone: 'primary', hint: 'Revenue or funding evidence, corroborated independently or by a strong relevant signal' },
  needs_qualification: { label: 'Needs qualification', tone: 'warning', hint: 'Promising or incomplete; more evidence is needed' },
  not_scored: { label: 'Not scored yet', tone: 'neutral', hint: 'Added or discovered, but not yet scored' },
  set_aside: { label: 'Set aside', tone: 'error', hint: 'Rejected by a reviewer, excluded at screening, or not a fit' },
};

export const FIT_LABELS: Record<FitStatus, string> = {
  verified_fit: 'Verified fit',
  probable_fit: 'Probable fit',
  needs_qualification: 'Needs qualification',
  not_fit: 'Not a fit',
};

export const SEGMENT_META: Record<DiscoverySegment, { label: string; tone: Tone }> = {
  emerging: { label: 'Emerging', tone: 'accent' },
  growing: { label: 'Growing', tone: 'secondary' },
  established: { label: 'Established', tone: 'primary' },
};

export const STATE_META: Record<ReviewState, { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'neutral' },
  shortlisted: { label: 'Shortlisted', tone: 'success' },
  on_hold: { label: 'On hold', tone: 'warning' },
  deferred: { label: 'Deferred', tone: 'secondary' },
  research_requested: { label: 'Research approved', tone: 'accent' },
  rejected: { label: 'Rejected', tone: 'error' },
};

export const ACTION_META: Record<ProspectDecisionKind, { label: string; prompt: string }> = {
  shortlist: { label: 'Shortlist', prompt: 'Why does this company deserve a closer look?' },
  request_research: { label: 'Approve deeper research', prompt: 'What should the deeper research answer?' },
  hold: { label: 'Put on hold', prompt: 'What are you waiting for?' },
  defer: { label: 'Defer', prompt: 'Why revisit this later, and when?' },
  reject: { label: 'Reject', prompt: 'Why is this company not worth pursuing?' },
  reopen: { label: 'Reopen', prompt: 'What changed that makes this worth another look?' },
};

export const NEXT_ACTION_META: Record<NextActionKey, { label: string; tone: Tone }> = {
  verify_commercial_capacity: { label: 'Verify commercial capacity', tone: 'warning' },
  validate_business_need: { label: 'Validate business need', tone: 'accent' },
  confirm_decision_maker: { label: 'Confirm decision-maker', tone: 'secondary' },
  investigate_website: { label: 'Investigate website', tone: 'primary' },
  defer: { label: 'Defer', tone: 'neutral' },
};

export const OVERRIDE_FIELD_LABELS: Record<OverrideField, string> = { score: 'Score', fit_status: 'Fit status', next_action: 'Next action' };

export const LEVEL_META: Record<AssessmentLevel, { label: string; tone: Tone }> = {
  strong: { label: 'Strong', tone: 'success' },
  moderate: { label: 'Moderate', tone: 'primary' },
  weak: { label: 'Weak', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

export const CONFIDENCE_TONE: Record<Confidence, Tone> = { high: 'success', medium: 'primary', low: 'warning' };

export const ORIGIN_LABELS: Record<string, string> = {
  phase0_selection: 'Initial selection',
  exa_discovery: 'Search discovery',
  provider_discovery: 'Data provider',
  manual_entry: 'Manual entry',
  csv_import: 'CSV import',
};
