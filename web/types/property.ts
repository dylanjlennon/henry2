export interface ParcelData {
  pin: string | null;
  owner: string | null;
  address: string | null;
  acreage: number | null;
  yearBuilt: number | null;
  sqFt: number | null;
  taxValue: number | null;
  municipality: string | null;
}

export interface JurisdictionData {
  jurisdiction: string;
  distCode: string | null;
  isAsheville: boolean;
  isUnincorporated: boolean;
}

export interface HistoricDistrictData {
  inLocalHistoricDistrict: boolean;
  districtName: string | null;
  layerChecked: string;
}

export interface LandslideHazardData {
  nearbyLandslideCount: number;
  slopeMovementCount: number;
  debrisFlowCount: number;
  stabilityIndex: number | null;
  stabilityLabel: string | null;
  riskLevel: 'none' | 'low' | 'moderate' | 'high';
}

export interface SlopeData {
  elevationFt: number | null;
  slopePct: number | null;
  slopeDeg: number | null;
}

export interface FemaFloodData {
  floodZone: string | null;
  sfha: boolean | null;
  firmPanel: string | null;
}

export interface STREligibilityData {
  eligible: boolean | null;
  summary: string;
  zoningDistrict: string | null;
  activePermitCount: number;
  activePermits: string[];
  rulesJurisdiction: string;
}

export interface NationalRiskIndexData {
  compositeScore: number | null;
  compositeRating: string | null;
  topHazards: string[];
}

export interface SoilSepticData {
  mapUnitName: string | null;
  componentName: string | null;
  texture: string | null;
  septicRating: string | null;
}

export interface AdjacentNeighbor {
  pin: string;
  owner: string;
  address: string;
  city: string;
  zoningCode: string;
}

export interface AdjacentParcelsData {
  neighbors: AdjacentNeighbor[];
  count: number;
}

export interface WebRunStatus {
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  address: string;
  fetchersTotal: number;
  fetchersCompleted: number;
  fetchersFailed: number;
  fetcherData: Record<string, Record<string, unknown>>;
  artifacts: Array<{ id: string; label: string; contentType: string }>;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface HistoryItem {
  runId: string;
  address: string;
  createdAt: string;
  status: string;
}
