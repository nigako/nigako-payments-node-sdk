/**
 * PaiementPro's mobile-money rails (Côte d'Ivoire) — **provider-specific**. A different payment provider
 * defines its own rail codes; the generic `PaymentGateway.initPayin` takes `channel` as an opaque
 * `string`, so this enum is a convenience for PaiementPro callers, not part of the generic surface.
 */
export enum PaiementProChannel {
  WAVECI = 'WAVECI', // Wave
  MOMOCI = 'MOMOCI', // MTN MoMo
  OMCIV2 = 'OMCIV2', // Orange Money
  FLOOZ = 'FLOOZ', // Moov Flooz
}
