#!/usr/bin/env node
/**
 * Verify Context Management Fix - checks config against Claude Code benchmarks
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'config', 'default.json');

console.log('🔍 OmniClaw Context Management Verification\n');

if (!fs.existsSync(configPath)) {
  console.error('❌ Config file not found:', configPath);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const checks = [
  {
    name: 'Context char budget (omniLoop)',
    path: 'runtime.omniLoop.contextCharBudget',
    min: 400000,
    optimal: 600000,
    current: config.runtime?.omniLoop?.contextCharBudget,
    unit: 'chars'
  },
  {
    name: 'Context tokens (omniLoop)',
    path: 'runtime.omniLoop.contextTokens',
    min: 600000,
    optimal: 800000,
    current: config.runtime?.omniLoop?.contextTokens,
    unit: 'tokens'
  },
  {
    name: 'Max tool result chars',
    path: 'runtime.omniLoop.maxToolResultChars',
    min: 20000,
    optimal: 25000,
    current: config.runtime?.omniLoop?.maxToolResultChars,
    unit: 'chars'
  },
  {
    name: 'History messages kept',
    path: 'runtime.omniLoop.historyMessages',
    min: 25,
    optimal: 30,
    current: config.runtime?.omniLoop?.historyMessages,
    unit: 'messages'
  },
  {
    name: 'Compaction threshold',
    path: 'runtime.omniLoop.compactAtPercent',
    min: 0.8,
    optimal: 0.85,
    current: config.runtime?.omniLoop?.compactAtPercent,
    unit: 'percent'
  },
  {
    name: 'Sub-agent context chars',
    path: 'runtime.subAgents.contextChars',
    min: 300000,
    optimal: 400000,
    current: config.runtime?.subAgents?.contextChars,
    unit: 'chars'
  },
  {
    name: 'read_file budget',
    path: 'runtime.omniLoop.toolResultBudgets.read_file',
    min: 15000,
    optimal: 20000,
    current: config.runtime?.omniLoop?.toolResultBudgets?.read_file,
    unit: 'chars'
  },
  {
    name: 'exec budget',
    path: 'runtime.omniLoop.toolResultBudgets.exec',
    min: 10000,
    optimal: 15000,
    current: config.runtime?.omniLoop?.toolResultBudgets?.exec,
    unit: 'chars'
  },
  {
    name: 'search_text budget',
    path: 'runtime.omniLoop.toolResultBudgets.search_text',
    min: 10000,
    optimal: 12000,
    current: config.runtime?.omniLoop?.toolResultBudgets?.search_text,
    unit: 'chars'
  },
  {
    name: 'Temperature (thinking control)',
    path: 'runtime.omniLoop.temperature',
    min: 0.0,
    optimal: 0.0,
    current: config.runtime?.omniLoop?.temperature,
    unit: '',
    exact: true
  },
];

let passed = 0;
let optimal = 0;
let failed = [];

for (const check of checks) {
  const val = check.current;

  if (val === undefined || val === null) {
    console.log(`⚠️  ${check.name}: NOT SET (path: ${check.path})`);
    failed.push(check.name);
    continue;
  }

  let status;
  if (check.exact) {
    status = val === check.optimal ? '✅' : '⚠️';
    if (val === check.optimal) {
      passed++;
      optimal++;
    }
  } else {
    if (val >= check.optimal) {
      status = '✅';
      passed++;
      optimal++;
    } else if (val >= check.min) {
      status = '⚠️';
      passed++;
    } else {
      status = '❌';
      failed.push(check.name);
    }
  }

  const unit = check.unit ? ` ${check.unit}` : '';
  const hint = check.exact
    ? `(must be ${check.optimal})`
    : `(min ${check.min}, optimal ${check.optimal})`;

  console.log(`${status} ${check.name}: ${val}${unit} ${hint}`);
}

console.log(`\n📊 Results: ${passed}/${checks.length} checks passed`);
console.log(`   Optimal: ${optimal}/${checks.length}`);

if (failed.length > 0) {
  console.log(`\n❌ Failed checks: ${failed.join(', ')}`);
  console.log('\nFix: Edit config/default.json to meet minimum requirements.');
  process.exit(1);
} else if (optimal < checks.length) {
  console.log(`\n⚠️  Context fix applied but not optimal. Consider increasing values marked with ⚠️.`);
  process.exit(0);
} else {
  console.log(`\n🎉 All context management settings are optimal! OmniClaw should now handle 1M context efficiently.`);
  process.exit(0);
}
