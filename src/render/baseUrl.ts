/**
 * A21: the app's public base path (Vite `base`, './' in this repo) for every runtime asset URL. Absolute '/arena/',
 * '/fx/', '/basis/' URLs worked on the dev server and at a domain root, but a build served from a sub-path (GitHub
 * Pages: https://<user>.github.io/<repo>/) fetched them from the domain root and got 404s: the kit arena (Moon Gate),
 * its backdrop and sky, the FX atlases and the KTX2 transcoder all fell back. Node tools (tsx) have no
 * import.meta.env, so they get '/'.
 */
export const BASE_URL: string = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/';

/** a public/ file's URL ('arena/manifest.json' -> './arena/manifest.json' in a build) */
export const assetUrl = (rel: string) => BASE_URL + rel.replace(/^\/+/, '');
