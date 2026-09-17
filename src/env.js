/**
 * env.js — Build-time environment values.
 *
 * The worker subdomain is injected at build time via esbuild's `define`
 * in build.js. To build for a different Cloudflare account:
 *
 *   PowerShell:  $env:SWEEP_WORKER_SUBDOMAIN = "other-subdomain"
 *   bash:        SWEEP_WORKER_SUBDOMAIN=other-subdomain npm run build
 *
 * All worker URLs in the client derive from this single value.
 */

export const WORKER_SUBDOMAIN = process.env.SWEEP_WORKER_SUBDOMAIN || 'smallcapstradingsystem';