"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AppUpdateResponse } from "@/lib/api-types";
import { readVersionInfo } from "@/lib/version-info";

/**
 * The three versions Settings › General ends with: this build, the upstream
 * release it tracks, and the pi agent installed. It used to be a line under the
 * brand on an empty chat, where it moved with the composer; here it is where
 * someone looks for it on purpose. The update link came with it.
 */

// One check per page: Settings can be reopened, and each open would otherwise
// ask again and lengthen the row under the reader's eyes.
let appUpdateCheck: Promise<AppUpdateResponse | null> | null = null;
let appUpdateFound: AppUpdateResponse | null = null;

function checkAppUpdate(): Promise<AppUpdateResponse | null> {
  appUpdateCheck ??= fetch("/api/app-update")
    .then(async (response) => {
      if (!response.ok) return null;
      const result = await response.json() as AppUpdateResponse;
      return result.updateAvailable && result.latestVersion && result.releaseUrl ? result : null;
    })
    .then((result) => {
      appUpdateFound = result;
      return result;
    })
    .catch(() => {
      // Best-effort: a failed check must never interrupt Settings, and a later
      // open asks again.
      appUpdateCheck = null;
      return null;
    });
  return appUpdateCheck;
}

/** One label/value row. The value is text, so it is the readable half. */
function VersionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-version-row">
      <span className="settings-version-label">{label}</span>
      <span className="settings-version-value">{children}</span>
    </div>
  );
}

export function VersionInfoSection() {
  const { t } = useI18n();
  const versions = readVersionInfo();
  const [update, setUpdate] = useState<AppUpdateResponse | null>(() => appUpdateFound);

  useEffect(() => {
    if (appUpdateFound) return;
    let cancelled = false;
    void checkAppUpdate().then((result) => {
      if (!cancelled && result) setUpdate(result);
    });
    return () => { cancelled = true; };
  }, []);

  const updateLabel = update
    ? t("settings.versionUpdateAvailable", { version: update.latestVersion })
    : null;

  return (
    <section className="settings-general-section">
      <div className="settings-general-info">
        <h3 className="settings-general-heading">{t("settings.version")}</h3>
        <p className="settings-general-description">{t("settings.versionDescription")}</p>
      </div>
      <div className="settings-general-control is-end">
        <div className="settings-version-list">
          <VersionRow label={t("settings.versionApp")}>
            {versions.app}
            {update && updateLabel && (
              <>
                {" → "}
                <a
                  className="settings-version-update"
                  href={update.releaseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={updateLabel}
                  aria-label={updateLabel}
                >
                  {updateLabel}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M7 17 17 7" />
                    <path d="M7 7h10v10" />
                  </svg>
                </a>
              </>
            )}
          </VersionRow>
          <VersionRow label={t("settings.versionUpstream", { repo: versions.upstreamRepo })}>
            {versions.upstream}
          </VersionRow>
          <VersionRow label={t("settings.versionPi")}>
            {versions.pi}
          </VersionRow>
        </div>
      </div>
    </section>
  );
}
