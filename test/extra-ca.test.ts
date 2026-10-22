import { describe, it } from 'node:test';
import assert from 'node:assert';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  ExtraCaUnsupportedError,
  extraCertificateProblem,
  pemCertificates,
  trustExtraCertificates
} from '../dist/catalog/extra-ca.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shipped = fs.readFileSync(path.join(repoRoot, 'catalog/extra-ca-certificates.pem'), 'utf8');

describe('extra CA certificates', () => {
  it('reads the certificates and skips the comments around them', () => {
    const certs = pemCertificates(shipped);
    assert.ok(certs.length > 0);
    for (const pem of certs) {
      assert.match(pem, /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/);
    }
  });

  it('ships only intermediates that chain to a root Node bundles', () => {
    for (const pem of pemCertificates(shipped)) {
      assert.strictEqual(extraCertificateProblem(pem), null, new X509Certificate(pem).subject);
    }
  });

  it('refuses a root certificate', () => {
    const [root] = tls.rootCertificates;
    assert.match(extraCertificateProblem(root) ?? '', /a root certificate/);
  });

  it('adds the certificates to the default trusted set', () => {
    let trusted: string[] = [];
    const added = trustExtraCertificates(shipped, {
      getCACertificates: () => ['bundled root'],
      setDefaultCACertificates: (certs: readonly (string | ArrayBufferView)[]) => {
        trusted = certs as string[];
      }
    });
    assert.strictEqual(added, pemCertificates(shipped).length);
    assert.deepStrictEqual(trusted, ['bundled root', ...pemCertificates(shipped)]);
  });

  it('says so clearly on a Node without the API', () => {
    assert.throws(() => trustExtraCertificates(shipped, {}), ExtraCaUnsupportedError);
  });

  it('refuses an intermediate whose root is not trusted', () => {
    const [pem] = pemCertificates(shipped);
    assert.match(extraCertificateProblem(pem, []) ?? '', /not issued by a root Node trusts/);
  });
});
