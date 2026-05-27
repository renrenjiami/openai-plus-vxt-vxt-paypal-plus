import { loadVersionCheckState, saveVersionCheckState } from './state';
import type { ReleaseVersionInfo, VersionCheckResult } from './types';

const LATEST_RELEASE_API = 'https://api.github.com/repos/renrenjiami/openai-plus-vxt-vxt-paypal-plus/releases/latest';
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

interface GithubReleaseAsset {
  browser_download_url?: string;
  name?: string;
}

interface GithubLatestRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets?: GithubReleaseAsset[];
}

export async function checkLatestVersion(force = false): Promise<VersionCheckResult> {
  const currentVersion = normalizeVersion(browser.runtime.getManifest().version);
  const state = await loadVersionCheckState();

  if (!force && state.latest && Date.now() - state.lastCheckedAt < CHECK_INTERVAL_MS) {
    return buildResult(currentVersion, state.latest, state.ignoredVersion);
  }

  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
    });

    if (response.status === 404) {
      await saveVersionCheckState({ latest: null, lastCheckedAt: Date.now() });
      return {
        currentVersion,
        latest: null,
        updateAvailable: false,
        ignored: false,
        error: '当前仓库还没有 GitHub Release',
      };
    }

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }

    const release = await response.json() as GithubLatestRelease;
    const latest = normalizeRelease(release);
    await saveVersionCheckState({ latest, lastCheckedAt: Date.now() });
    return buildResult(currentVersion, latest, state.ignoredVersion);
  } catch (error) {
    return {
      currentVersion,
      latest: state.latest,
      updateAvailable: Boolean(state.latest && compareVersions(state.latest.version, currentVersion) > 0),
      ignored: Boolean(state.latest && state.ignoredVersion === state.latest.version),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left).split('.').map(toNumber);
  const b = normalizeVersion(right).split('.').map(toNumber);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function buildResult(
  currentVersion: string,
  latest: ReleaseVersionInfo | null,
  ignoredVersion: string,
): VersionCheckResult {
  const updateAvailable = Boolean(latest && compareVersions(latest.version, currentVersion) > 0);
  const ignored = Boolean(latest && ignoredVersion === latest.version);
  return {
    currentVersion,
    latest,
    updateAvailable,
    ignored,
  };
}

function normalizeRelease(release: GithubLatestRelease): ReleaseVersionInfo | null {
  const tagName = String(release.tag_name || '').trim();
  const version = normalizeVersion(tagName);
  const htmlUrl = String(release.html_url || '').trim();
  if (!version || !htmlUrl) {
    return null;
  }

  const assetUrl = release.assets?.find((asset) => {
    const name = String(asset.name || '').toLowerCase();
    return name.endsWith('.zip') && name.includes('chrome');
  })?.browser_download_url || release.assets?.find((asset) => String(asset.name || '').toLowerCase().endsWith('.zip'))?.browser_download_url;

  return {
    version,
    tagName,
    name: String(release.name || tagName).trim(),
    body: String(release.body || '').trim(),
    htmlUrl,
    downloadUrl: String(assetUrl || htmlUrl).trim(),
    publishedAt: String(release.published_at || '').trim(),
  };
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '');
}

function toNumber(value: string): number {
  const parsed = Number.parseInt(value.replace(/\D.*$/, ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
