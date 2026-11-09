import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const serverSource = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));

function http(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    // Preserve the raw path: fetch/URL would normalize traversal before it reaches the server.
    const req = request(
      { host: '127.0.0.1', port, path, method, headers, agent: false },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', reject);
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error('Test HTTP timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error('Server startup timeout: ' + output)), 5000);
    const exited = (code) => finish(new Error(`Server exited ${code}: ${output}`));
    const data = (chunk) => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)\//u.exec(output);
      if (match) finish(null, Number(match[1]));
    };
    function finish(error, port) {
      clearTimeout(timer);
      child.off('exit', exited);
      child.stdout.off('data', data);
      child.stderr.off('data', data);
      if (error) reject(error);
      else resolve(port);
    }
    child.once('error', finish);
    child.once('exit', exited);
    child.stdout.on('data', data);
    child.stderr.on('data', data);
  });
}

test(
  'runtime connection config is public-key-only and narrowly extends CSP',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'demography-cloud-config-'));
    let child;
    const stop = async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit');
        child.kill('SIGTERM');
        await closed;
      }
    };
    t.after(async () => {
      await stop();
      await rm(root, { recursive: true, force: true });
    });
    for (const folder of ['scripts', 'dist', 'public'])
      await mkdir(join(root, folder), { recursive: true });
    await copyFile(serverSource, join(root, 'scripts/serve.mjs'));
    await writeFile(join(root, 'dist/index.html'), '<!doctype html><title>Config fixture</title>');
    const config = {
      schemaVersion: 1,
      supabaseUrl: 'https://workshop.example.test',
      supabasePublishableKey: 'sb_publishable_public_config_fixture',
      realtime: true,
    };
    const start = () => {
      child = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], {
        cwd: root,
        env: { ...process.env, PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return waitForServer(child);
    };
    await writeFile(join(root, 'public/workshop-config.json'), JSON.stringify(config));
    let port = await start();
    const response = await http(port, '/workshop-config.json');
    assert.deepEqual(JSON.parse(response.body.toString()), config);
    assert.equal(response.headers['cache-control'], 'no-store');
    const csp = (await http(port, '/')).headers['content-security-policy'];
    assert.match(
      csp,
      /connect-src 'self' https:\/\/workshop\.example\.test wss:\/\/workshop\.example\.test(?:;|$)/u,
    );
    assert.doesNotMatch(csp, /\*/u);
    await stop();
    const surveyConfig = {
      ...config,
      surveyUrl: 'https://survey.example.test/workshop/survey.html',
      classroomOrigin: 'https://class.example.test',
    };
    await writeFile(join(root, 'public/workshop-config.json'), JSON.stringify(surveyConfig));
    port = await start();
    assert.deepEqual(
      JSON.parse((await http(port, '/workshop-config.json')).body.toString()),
      surveyConfig,
    );
    await stop();
    await writeFile(
      join(root, 'public/workshop-config.json'),
      JSON.stringify({ ...surveyConfig, classroomOrigin: 'https://survey.example.test' }),
    );
    await assert.rejects(start(), /Server exited 1/u);
    for (const forbiddenKey of [
      'sb_secret_fixture_must_never_be_exposed',
      `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`,
    ]) {
      await writeFile(
        join(root, 'public/workshop-config.json'),
        JSON.stringify({ ...config, supabasePublishableKey: forbiddenKey }),
      );
      await assert.rejects(start(), /Server exited 1/u);
    }
  },
);

test(
  'standalone release server with fixture build and no node_modules',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'demography-release-test-'));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit');
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 6000);
        force.unref();
        await closed;
        clearTimeout(force);
      }
      await rm(root, { recursive: true, force: true });
    });
    const data = join(root, 'public/data');
    for (const directory of [
      'scripts',
      'dist/assets',
      'dist/data/corpus',
      'public/data/corpus',
      'apps/web/src',
    ]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await copyFile(serverSource, join(root, 'scripts/serve.mjs'));
    await writeFile(
      join(root, 'dist/index.html'),
      '<!doctype html><html lang="ru"><title>Compiled fixture</title><div id="root"></div></html>',
    );
    await writeFile(join(root, 'dist/assets/app-fixture.js'), 'globalThis.fixture = true;');
    await writeFile(
      join(root, 'dist/survey.html'),
      '<!doctype html><title>Independent questionnaire</title>',
    );
    await writeFile(
      join(root, 'dist/assets/app-fixture.js.map'),
      '{"sourcesContent":["PRIVATE SOURCE MAP"]}',
    );
    await writeFile(join(root, 'dist/assets/private.ts'), 'PRIVATE TYPESCRIPT SOURCE');
    await writeFile(join(root, 'apps/web/src/main.tsx'), 'PRIVATE APPLICATION SOURCE');
    await writeFile(join(root, 'package.json'), '{"private":"ROOT PACKAGE"}');
    await writeFile(join(root, '.env'), 'PRIVATE_ENV=secret');
    await writeFile(join(data, '.hidden.json'), '{"private":"DOTFILE"}');
    const fixture = JSON.stringify({
      schemaVersion: 1,
      marker: 'Public corpus fallback',
      sample: 'Региональная программа. '.repeat(500),
    });
    await writeFile(join(data, 'corpus/index.json'), fixture);
    await writeFile(join(data, 'regions.geojson'), '{"type":"FeatureCollection","features":[]}');
    await writeFile(join(root, 'public/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(join(root, 'dist/data/corpus/priority.json'), '{"from":"dist"}');
    await writeFile(join(data, 'corpus/priority.json'), '{"from":"public"}');
    child = spawn(process.execPath, [join(root, 'scripts/serve.mjs')], {
      cwd: tmpdir(),
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await waitForServer(child);

    await t.test(
      'serves the compiled entry and assets with same-origin security headers',
      async () => {
        const page = await http(port, '/');
        assert.equal(page.status, 200);
        assert.match(page.body.toString(), /Compiled fixture/u);
        assert.match(page.headers['content-type'], /^text\/html; charset=utf-8$/u);
        assert.match(page.headers['content-security-policy'], /script-src 'self'/u);
        assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe/u);
        assert.match(page.headers['content-security-policy'], /style-src 'self' 'unsafe-inline'/u);
        assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/u);
        assert.equal(page.headers['x-content-type-options'], 'nosniff');
        assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(page.headers['access-control-allow-origin'], undefined);
        const asset = await http(port, '/assets/app-fixture.js');
        assert.equal(asset.status, 200);
        assert.match(asset.headers['content-type'], /javascript/u);
        const survey = await http(port, '/survey.html');
        assert.equal(survey.status, 200);
        assert.match(survey.body.toString(), /Independent questionnaire/u);
        assert.equal(survey.headers['referrer-policy'], 'no-referrer');
        assert.equal(survey.headers['set-cookie'], undefined);
      },
    );

    await t.test(
      'uses public/data only as a data fallback, preserves dist priority and correct MIME',
      async () => {
        const corpus = await http(port, '/data/corpus/index.json?version=1');
        assert.equal(corpus.status, 200);
        assert.equal(corpus.body.toString(), fixture);
        assert.match(corpus.headers['content-type'], /^application\/json; charset=utf-8$/u);
        assert.equal(
          JSON.parse((await http(port, '/data/corpus/priority.json')).body).from,
          'dist',
        );
        assert.match(
          (await http(port, '/data/regions.geojson')).headers['content-type'],
          /^application\/geo\+json/u,
        );
        assert.equal((await http(port, '/favicon.svg')).status, 200);
        const missing = await http(port, '/data/corpus/missing.json');
        assert.equal(missing.status, 404);
        assert.match(missing.headers['content-type'], /^text\/plain/u);
        assert.doesNotMatch(missing.body.toString(), /Compiled fixture/u);
      },
    );

    await t.test(
      'serves only bundled export fonts and their license, preserving fallback and rejecting symlink escape',
      async (inner) => {
        const distFonts = join(root, 'dist/fonts');
        const publicFonts = join(root, 'public/fonts');
        await mkdir(distFonts, { recursive: true });
        await mkdir(publicFonts, { recursive: true });
        // Synthetic binary payloads exercise file delivery, not font shaping.
        const regular = Buffer.from([0, 1, 0, 0, 68, 73, 83, 84]);
        const fallbackRegular = Buffer.from([0, 1, 0, 0, 80, 85, 66, 76, 73, 67]);
        const bold = Buffer.from([0, 1, 0, 0, 66, 79, 76, 68]);
        const license = 'Synthetic DejaVu license delivery fixture.\n';
        await writeFile(join(distFonts, 'DejaVuSans.ttf'), regular);
        await writeFile(join(publicFonts, 'DejaVuSans.ttf'), fallbackRegular);
        await writeFile(join(publicFonts, 'DejaVuSans-Bold.ttf'), bold);
        await writeFile(join(publicFonts, 'LICENSE-DejaVu.txt'), license);
        await writeFile(join(distFonts, 'other.txt'), 'PRIVATE unapproved text in dist');
        await writeFile(join(publicFonts, 'other.txt'), 'PRIVATE unapproved text in public');
        await writeFile(join(publicFonts, 'other.ttf'), 'PRIVATE unapproved font');

        const regularResponse = await http(port, '/fonts/DejaVuSans.ttf');
        assert.equal(regularResponse.status, 200);
        assert.equal(regularResponse.headers['content-type'], 'font/ttf');
        assert.equal(regularResponse.headers['x-content-type-options'], 'nosniff');
        assert.deepEqual(regularResponse.body, regular);
        assert.equal(Number(regularResponse.headers['content-length']), regular.length);
        const boldResponse = await http(port, '/fonts/DejaVuSans-Bold.ttf');
        assert.equal(boldResponse.status, 200);
        assert.equal(boldResponse.headers['content-type'], 'font/ttf');
        assert.deepEqual(boldResponse.body, bold);
        const licenseResponse = await http(port, '/fonts/LICENSE-DejaVu.txt');
        assert.equal(licenseResponse.status, 200);
        assert.equal(licenseResponse.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(licenseResponse.body.toString(), license);
        for (const path of ['/fonts/other.txt', '/fonts/other.ttf']) {
          const denied = await http(port, path);
          assert.equal(denied.status, 404);
          assert.doesNotMatch(denied.body.toString(), /PRIVATE/u);
        }

        // Both search roots must reject even allowlisted names when they resolve
        // outside the fonts tree. Remove valid fallbacks so a 404 is unambiguous.
        await rm(join(publicFonts, 'DejaVuSans.ttf'));
        await rm(join(distFonts, 'DejaVuSans.ttf'));
        await rm(join(publicFonts, 'DejaVuSans-Bold.ttf'));
        try {
          await symlink(join(root, 'package.json'), join(distFonts, 'DejaVuSans.ttf'), 'file');
          await symlink(
            join(root, 'package.json'),
            join(publicFonts, 'DejaVuSans-Bold.ttf'),
            'file',
          );
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
            inner.diagnostic(
              'Symlink assertions unavailable on this host; delivery and allowlist assertions completed.',
            );
            return;
          }
          throw error;
        }
        for (const path of ['/fonts/DejaVuSans.ttf', '/fonts/DejaVuSans-Bold.ttf']) {
          const escaped = await http(port, path);
          assert.equal(escaped.status, 404);
          assert.doesNotMatch(escaped.body.toString(), /ROOT PACKAGE/u);
        }
      },
    );

    await t.test('denies dotfiles, traversal, malformed escapes and source paths', async () => {
      const forbidden = [
        '/../package.json',
        '/%2e%2e/package.json',
        '/data/%2e%2e/package.json',
        '/data/%2e%2e/%2e%2e/package.json',
        '/data/%252e%252e/package.json',
        '/data/%5c..%5cpackage.json',
        '/.env',
        '/data/.hidden.json',
      ];
      for (const path of forbidden) {
        const response = await http(port, path);
        assert.ok([400, 403].includes(response.status), `${path}: ${response.status}`);
        assert.doesNotMatch(response.body.toString(), /PRIVATE|ROOT PACKAGE/u);
      }
      for (const path of ['/data/%ZZ.json', '/data/%C0%AFsecret.json', '/data/%00index.json']) {
        assert.equal((await http(port, path)).status, 400, path);
      }
      for (const path of [
        '/package.json',
        '/scripts/serve.mjs',
        '/apps/web/src/main.tsx',
        '/README.md',
        '/assets/app-fixture.js.map',
        '/assets/private.ts',
        '/public/data/corpus/index.json',
      ]) {
        assert.equal((await http(port, path)).status, 404, path);
      }
    });

    await t.test('does not follow a data symlink outside the permitted tree', async (inner) => {
      try {
        await symlink(join(root, 'package.json'), join(data, 'outside.json'), 'file');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
          inner.skip('Symlinks unavailable on this host');
          return;
        }
        throw error;
      }
      const response = await http(port, '/data/outside.json');
      assert.equal(response.status, 404);
      assert.doesNotMatch(response.body.toString(), /ROOT PACKAGE/u);
    });

    await t.test(
      'negotiates gzip, supports HEAD and conditional requests, and refreshes cached data',
      async () => {
        const encoded = await http(port, '/data/corpus/index.json', {
          headers: { 'accept-encoding': 'gzip' },
        });
        assert.equal(encoded.status, 200);
        assert.equal(encoded.headers['content-encoding'], 'gzip');
        assert.equal(encoded.headers.vary, 'Accept-Encoding');
        assert.equal(Number(encoded.headers['content-length']), encoded.body.length);
        assert.equal(gunzipSync(encoded.body).toString(), fixture);
        const head = await http(port, '/data/corpus/index.json', {
          method: 'HEAD',
          headers: { 'accept-encoding': 'gzip' },
        });
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(head.headers['content-length'], encoded.headers['content-length']);
        assert.equal(head.headers.etag, encoded.headers.etag);
        const unchanged = await http(port, '/data/corpus/index.json', {
          headers: { 'accept-encoding': 'gzip', 'if-none-match': encoded.headers.etag },
        });
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.body.length, 0);
        const plain = await http(port, '/data/corpus/index.json', {
          headers: { 'accept-encoding': 'gzip;q=0, identity;q=1' },
        });
        assert.equal(plain.headers['content-encoding'], undefined);
        assert.equal(plain.body.toString(), fixture);
        assert.notEqual(plain.headers.etag, encoded.headers.etag);
        const updated = JSON.stringify({ changed: true });
        await writeFile(join(data, 'corpus/index.json'), updated);
        const future = new Date(Date.now() + 2000);
        await utimes(join(data, 'corpus/index.json'), future, future);
        const fresh = await http(port, '/data/corpus/index.json', {
          headers: { 'accept-encoding': 'gzip', 'if-none-match': encoded.headers.etag },
        });
        assert.equal(fresh.status, 200);
        assert.notEqual(fresh.headers.etag, encoded.headers.etag);
        assert.equal(gunzipSync(fresh.body).toString(), updated);
      },
    );

    await t.test(
      'permits only GET and HEAD and never writes a submitted body to disk',
      async () => {
        const before = (await http(port, '/data/corpus/index.json')).body;
        for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
          const response = await http(port, '/data/corpus/index.json', {
            method,
            body: '{"overwrite":"attempt"}',
          });
          assert.equal(response.status, 405);
          assert.equal(response.headers.allow, 'GET, HEAD');
          assert.equal(response.headers['cache-control'], 'no-store');
        }
        assert.deepEqual((await http(port, '/data/corpus/index.json')).body, before);
        const head = await http(port, '/missing.json', { method: 'HEAD' });
        assert.equal(head.status, 404);
        assert.equal(head.body.length, 0);
      },
    );
  },
);
