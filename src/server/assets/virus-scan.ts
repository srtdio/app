// Virus scanning boundary.
//
// The pipeline depends only on the VirusScanner interface; the concrete scanner
// is chosen from VIRUS_SCAN_PROVIDER at the Worker edge. Today the only provider
// is the NoOpScanner, which always reports clean - the real ClamAV (or vendor)
// integration drops in behind this interface without touching the pipeline. A
// scanner reporting `clean: false` is an expected outcome, not an exception.

export interface VirusScanResult {
  clean: boolean;
  /** Signature/threat name when not clean. */
  reason?: string;
}

export interface VirusScanner {
  scan(bytes: Uint8Array): Promise<VirusScanResult>;
}

/** Default provider: trusts every upload. Replaced once ClamAV lands. */
export class NoOpScanner implements VirusScanner {
  scan(): Promise<VirusScanResult> {
    return Promise.resolve({ clean: true });
  }
}

/**
 * Resolve a scanner from the env value. Unknown/empty values fall back to the
 * NoOpScanner so a misconfiguration fails open to "scanned clean" rather than
 * blocking every upload; tighten this when a real provider exists.
 */
export function selectScanner(provider: string | undefined): VirusScanner {
  switch (provider) {
    case 'noop':
    case undefined:
    case '':
      return new NoOpScanner();
    default:
      return new NoOpScanner();
  }
}
