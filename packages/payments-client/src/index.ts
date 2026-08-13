// Generic, provider-agnostic contract:
export * from './payment-gateway';
// PaiementPro implementation (+ its provider-specific rail codes):
export * from './paiement-pro.channels';
export * from './paiement-pro.gateway';
