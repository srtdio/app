// Deterministic bucketing for percentage rollouts and experiments.
//
// The bucket is a stable function of (userId, flagName): the same pair always
// lands in the same bucket, so a user's rollout/experiment assignment is sticky
// across calls and across processes. We hash with SHA-256 (via Web Crypto, which
// is present in both Node and Cloudflare Workers), take the first 4 bytes as a
// big-endian uint32, and reduce mod 100 to a bucket in [0, 99].
//
// A row's rollout_percentage P enables the principal when bucket < P. With the
// allowed set {0, 10, 25, 50, 100}: 0 never enables (nothing is < 0) and 100
// always enables (every bucket is < 100).

export async function bucketFor(userId: string, flagName: string): Promise<number> {
  const input = new TextEncoder().encode(`${userId}${flagName}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const first4 = new DataView(digest).getUint32(0, false);
  return first4 % 100;
}
