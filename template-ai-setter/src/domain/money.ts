/** GENERATED from domain/spec — do not edit. Run `node domain/codegen/generate.mjs`. */

/** Every currency a student can bill in. The order is the order pickers show. */
export const CURRENCIES = ["SEK","NOK","DKK","GBP","EUR","USD","BRL"] as const;
export type CurrencyCode = (typeof CURRENCIES)[number];

export const CURRENCY_LABELS: Record<string, string> = {
  "SEK": "Swedish krona",
  "NOK": "Norwegian krone",
  "DKK": "Danish krone",
  "GBP": "British pound",
  "EUR": "Euro",
  "USD": "US dollar",
  "BRL": "Brazilian real"
};

const CFG: Record<string, { locale: string; symbol: string; prefix: boolean }> = {
  "SEK": {
    "locale": "sv-SE",
    "symbol": "kr",
    "prefix": false
  },
  "NOK": {
    "locale": "nb-NO",
    "symbol": "NOK",
    "prefix": false
  },
  "DKK": {
    "locale": "da-DK",
    "symbol": "DKK",
    "prefix": false
  },
  "GBP": {
    "locale": "en-GB",
    "symbol": "£",
    "prefix": true
  },
  "EUR": {
    "locale": "de-DE",
    "symbol": "€",
    "prefix": true
  },
  "USD": {
    "locale": "en-US",
    "symbol": "$",
    "prefix": true
  },
  "BRL": {
    "locale": "pt-BR",
    "symbol": "R$ ",
    "prefix": true
  }
};

export const DEFAULT_CURRENCY = "SEK";

/** Is this a currency we can actually format? Every writer must ask before it
 * stores a code, or the picker and the formatter drift apart again and somebody's
 * money renders as somebody else's. Case-insensitive; returns the canonical code. */
export function asCurrency(value: unknown): CurrencyCode | null {
  const c = String(value ?? "").trim().toUpperCase();
  return (CURRENCIES as readonly string[]).includes(c) ? (c as CurrencyCode) : null;
}

/** The config for a currency code, falling back to the default. Unknown codes hit
 * the fallback, which is why the picker and this table have to be generated from
 * one list: an option nobody can format renders as somebody else's money. */
export function currencyCfg(currency?: string | null) {
  // trim() matters: client rows store free-text codes and a padded " GBP "
  // used to fall through to the default and render as kronor.
  return CFG[String(currency || DEFAULT_CURRENCY).trim().toUpperCase()] || CFG[DEFAULT_CURRENCY];
}

/** Format an amount in a student's currency, no decimals ("1 234 kr", "£1,234"). */
export function fmtMoney(value: number, currency?: string | null): string {
  const c = currencyCfg(currency);
  const n = (value || 0).toLocaleString(c.locale, { maximumFractionDigits: 0 });
  return c.prefix ? `${c.symbol}${n}` : `${n} ${c.symbol}`;
}

/** The number locale, for dense tables that show an amount with no symbol. */
export function moneyLocale(currency?: string | null): string {
  return currencyCfg(currency).locale;
}
