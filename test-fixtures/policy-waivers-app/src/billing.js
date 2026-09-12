// Legacy naming: this service still reads API_URL, while every other service in
// the repo (and .env) uses API_BASE_URL.
export const endpoint = process.env.API_URL;
export const legacy = process.env.LEGACY_TOKEN;
