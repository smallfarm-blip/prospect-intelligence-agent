export const FACT_STATUSES = ["verified", "provider_estimate", "inferred", "unknown", "contradicted"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export type FactAttribute =
  | "revenue_annual_usd"
  | "employee_count"
  | "hq_country"
  | "category"
  | "business_model"
  | "sells_dtc"
  | "founded_year"
  | "funding_total_usd"
  | "ecommerce_platform"
  | "experimentation_tools"
  | "promotion_tools"
  | "catalog_size"
  | "leadership_model";

export type FactSourceType = "provider" | "company_site" | "third_party" | "ai_screening" | "manual_import" | "reviewer";

export interface Fact {
  attribute: FactAttribute;
  valueText: string;
  valueNumber: number | null;
  status: FactStatus;
  sourceType: FactSourceType;
  sourceUrl: string | null;
  provider: string | null;
  excerpt: string | null;
  notes?: string | null;
  checkedAt: string;
}

export const CATEGORIES = ["apparel", "beauty", "home", "wellness", "specialty_consumer_goods", "other"] as const;
export const TARGET_CATEGORIES = new Set<string>(["apparel", "beauty", "home", "wellness", "specialty_consumer_goods"]);
export const BUSINESS_MODELS = ["dtc_brand", "retailer_multi_brand", "marketplace", "agency", "software_vendor", "enterprise_brand", "unclear"] as const;

export const SIGNAL_TYPES = ["business_trigger", "growth_initiative", "organizational_change", "visitor_experience", "promotional_orchestration"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
export type Confidence = "low" | "medium" | "high";

export interface Signal {
  signalType: SignalType;
  title: string;
  observedEvidence: string;
  interpretation: string;
  businessRelevance: string;
  criticalUnknowns: string[];
  nextValidation: string;
  sourceUrls: string[];
  confidence: Confidence;
}

export const ROLE_CATEGORIES = ["founder", "ecommerce_lead", "growth_marketing_lead", "digital_lead", "executive", "other"] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

export interface DecisionMaker {
  name: string;
  title: string | null;
  roleCategory: RoleCategory;
  profileUrl: string | null;
  sourceUrl: string | null;
  sourcePublishedAt: string | null;
  review: "confirmed" | "rejected" | null;
}

export type FitStatus = "verified_fit" | "probable_fit" | "needs_qualification" | "not_fit";

/** Normalised company record shared by every discovery provider. */
export interface CompanyEntity {
  name: string | null;
  description: string | null;
  foundedYear: number | null;
  employeeCount: number | null;
  hqCity: string | null;
  hqCountry: string | null;
  revenueAnnualUsd: number | null;
  fundingTotalUsd: number | null;
  latestRound: { name: string | null; date: string | null; amountUsd: number | null } | null;
}
