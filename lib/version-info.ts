/**
 * The three versions Settings › General reports, so "which build am I running,
 * and what is it built on?" has one answer in one place.
 *
 * - Pi Obs: this fork's own `package.json` version, injected by next.config.ts
 *   as NEXT_PUBLIC_APP_VERSION (see lib/next-config-esm.test.mjs).
 * - Upstream: the agegr/pi-web release this fork tracks. It is a plain
 *   constant, not a lookup: a build must not depend on the network to name its
 *   own base, and an offline or rate-limited check would leave the row blank or
 *   flashing. Bump it by hand when syncing from upstream.
 * - pi: the @earendil-works/pi-coding-agent actually installed, read from
 *   node_modules at build time into NEXT_PUBLIC_PI_VERSION.
 */
export const PI_OBS_UPSTREAM_REPO = "agegr/pi-web";

/** The agegr/pi-web release this fork is based on. Bump by hand on a sync. */
export const PI_OBS_UPSTREAM_VERSION = "0.12.1";

export interface VersionInfo {
  /** This fork's own version (package.json → NEXT_PUBLIC_APP_VERSION). */
  app: string;
  /** The upstream release tracked. */
  upstream: string;
  /** The upstream repository those versions come from. */
  upstreamRepo: string;
  /** The installed pi coding agent (NEXT_PUBLIC_PI_VERSION). */
  pi: string;
}

/** The versions as the build sees them; "0.0.0"/"unknown" before next.config runs. */
export function readVersionInfo(): VersionInfo {
  return {
    app: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
    upstream: PI_OBS_UPSTREAM_VERSION,
    upstreamRepo: PI_OBS_UPSTREAM_REPO,
    pi: process.env.NEXT_PUBLIC_PI_VERSION ?? "unknown",
  };
}
