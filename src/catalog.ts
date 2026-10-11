export interface Product {
  name: string;
  unitAmount: number; // smallest currency unit (cents)
  currency: string;
}

// A tiny fixed catalog. Prices live on the server, never in the request,
// so a client cannot choose its own price.
export const CATALOG: Record<string, Product> = {
  sticker: { name: 'Sticker pack', unitAmount: 500, currency: 'usd' },
  mug: { name: 'Coffee mug', unitAmount: 1500, currency: 'usd' },
};
