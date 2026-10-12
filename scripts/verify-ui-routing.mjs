#!/usr/bin/env node
/**
 * Verify UI Routing - checks that new UI is default
 */
import http from 'http';

console.log('🔍 OmniClaw UI Routing Verification\n');

const PORT = process.env.PORT || 3147;
const HOST = 'localhost';

function checkRoute(path, expectedRedirect = null) {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}${path}`, { timeout: 5000 }, (res) => {
      const status = res.statusCode;
      const location = res.headers.location;

      if (expectedRedirect) {
        if (status === 301 || status === 302) {
          if (location === expectedRedirect) {
            console.log(`✅ ${path} → redirects to ${location}`);
            resolve({ ok: true });
          } else {
            console.log(`❌ ${path} → redirects to ${location} (expected ${expectedRedirect})`);
            resolve({ ok: false });
          }
        } else {
          console.log(`❌ ${path} → status ${status} (expected redirect)`);
          resolve({ ok: false });
        }
      } else {
        if (status === 200) {
          console.log(`✅ ${path} → serves content (${status})`);
          resolve({ ok: true });
        } else {
          console.log(`❌ ${path} → status ${status} (expected 200)`);
          resolve({ ok: false });
        }
      }

      res.resume(); // Drain response
    });

    req.on('error', (err) => {
      console.log(`⚠️  ${path} → connection failed (server not running?)`);
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.log(`⚠️  ${path} → timeout`);
      resolve({ ok: false });
    });
  });
}

async function main() {
  console.log(`Testing routes on http://${HOST}:${PORT}\n`);

  const tests = [
    { path: '/', redirect: null, desc: 'Root serves new UI (web-next)' },
    { path: '/classic', redirect: null, desc: 'Old UI accessible at /classic' },
    { path: '/next', redirect: '/', desc: '/next redirects to /' },
    { path: '/next/', redirect: '/', desc: '/next/ redirects to /' },
    { path: '/js/main.js', redirect: null, desc: 'New UI assets served from /' },
    { path: '/css/layout.css', redirect: null, desc: 'New UI CSS served from /' },
  ];

  let passed = 0;
  for (const test of tests) {
    const result = await checkRoute(test.path, test.redirect);
    if (result.ok) passed++;
    if (result.error && result.error.includes('ECONNREFUSED')) {
      console.log('\n⚠️  Server not running. Start with: npm run dev\n');
      process.exit(1);
    }
  }

  console.log(`\n📊 Results: ${passed}/${tests.length} checks passed\n`);

  if (passed === tests.length) {
    console.log('🎉 New UI is now the default! Open http://localhost:3147/');
    console.log('   Old UI available at: http://localhost:3147/classic\n');
    process.exit(0);
  } else {
    console.log('❌ Some routing checks failed. Review server.js changes.\n');
    process.exit(1);
  }
}

main();
