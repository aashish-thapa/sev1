/**
 * How hard an incident is, matched to the career level that unlocks it (tier = level + 1):
 * 1 guided, one cause, one fix · 2 diagnose · 3 a plausible fix backfires ·
 * 4 the usual fix does nothing · 5 cloud-scale or cross-team.
 */
export type Tier = 1 | 2 | 3 | 4 | 5;
