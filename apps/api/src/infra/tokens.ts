/** Nest DI tokens. Every injection is explicit (no reflection metadata needed). */
export const CONFIG = Symbol("CONFIG");
export const PG_POOL = Symbol("PG_POOL");
export const LOGGER = Symbol("LOGGER");
export const STORAGE = Symbol("STORAGE");
export const MAILER = Symbol("MAILER");
export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
export const SMS = Symbol("SMS");
