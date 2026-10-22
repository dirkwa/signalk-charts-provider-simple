/**
 * Intermediate CA certificates that some ENC download servers leave out of
 * their TLS handshake (`catalog/extra-ca-certificates.pem`). A browser
 * fetches a missing intermediate itself; Node rejects the connection
 * instead. Adding the intermediate to Node's trusted set keeps verification
 * fully on: every chain must still end at a root Node already trusts, which
 * `extraCertificateProblem` checks for each certificate before it is used.
 */

import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The PEM certificates in a file, ignoring any comment lines around them. */
export function pemCertificates(text: string): string[] {
  return text.match(PEM_BLOCK) ?? [];
}

/**
 * Why a certificate does not belong in the extra set, or null when it
 * does: it must be a CA certificate, not a root, and signed by one of the
 * roots Node bundles.
 */
export function extraCertificateProblem(
  pem: string,
  roots: readonly string[] = tls.rootCertificates
): string | null {
  const cert = new X509Certificate(pem);
  if (!cert.ca) {
    return `${cert.subject}: not a CA certificate`;
  }
  if (cert.checkIssued(cert)) {
    return `${cert.subject}: a root certificate, not an intermediate`;
  }
  const anchored = roots.some((root) => {
    const issuer = new X509Certificate(root);
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  });
  return anchored ? null : `${cert.subject}: not issued by a root Node trusts`;
}

/** This Node cannot change its trusted set: the API arrived in Node 22.15. */
export class ExtraCaUnsupportedError extends Error {
  constructor() {
    super(`Node ${process.version} cannot add trusted certificates (needs 22.15 or later)`);
    this.name = 'ExtraCaUnsupportedError';
  }
}

type TrustApi = Partial<Pick<typeof tls, 'getCACertificates' | 'setDefaultCACertificates'>>;

/**
 * Add the certificates in `text` to the default trusted set used by every
 * TLS connection in this process, including `fetch`. Throws if one of them
 * is not an intermediate under a bundled root, and `ExtraCaUnsupportedError`
 * on a Node without the API. Returns how many were added.
 */
export function trustExtraCertificates(text: string, api: TrustApi = tls): number {
  const extra = pemCertificates(text);
  const problems = extra
    .map((pem) => extraCertificateProblem(pem))
    .filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new Error(`Refusing extra CA certificates:\n  ${problems.join('\n  ')}`);
  }
  if (extra.length === 0) {
    return 0;
  }
  if (!api.getCACertificates || !api.setDefaultCACertificates) {
    throw new ExtraCaUnsupportedError();
  }
  api.setDefaultCACertificates([...api.getCACertificates('default'), ...extra]);
  return extra.length;
}
