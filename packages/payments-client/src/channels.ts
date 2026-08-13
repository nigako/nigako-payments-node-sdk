/**
 * PaiementPro mobile-money rails (Côte d'Ivoire). The client picks one at checkout; the gateway
 * forwards it verbatim and PaiementPro echoes it on the notification callback.
 */
export enum PaiementProChannel {
  WAVECI = 'WAVECI', // Wave
  MOMOCI = 'MOMOCI', // MTN MoMo
  OMCIV2 = 'OMCIV2', // Orange Money
  FLOOZ = 'FLOOZ', // Moov Flooz
}
